"""BridgeService: the long-running bridge behind `walkpad-bridge serve`.

Owns the pad connection (reconnecting whenever the pad is unreachable), the SpeedController,
the session recorder, and the fan-out of live data to WebSocket subscribers and UDP.

Every sample goes through one loop: controller.observe() (cap and hold), recorder, subscribers,
UDP. Belt commands go through the controller only.

Controlling clients are identified by a client id (the web page picks one and keeps it across
reloads). A client may control the belt only while it has a live WebSocket open, so that its
disappearance is noticed: when the controlling client's last WebSocket closes, the service waits
`client_grace_s` for it to come back (page refresh, Wi-Fi blip), then ramps the belt down and
stops it.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections import Counter
from collections.abc import Callable
from typing import Any

from .backend import BackendError, BeltState, PadBackend, Sample
from .clock import Clock, MonotonicClock
from .config import Config
from .recorder import SessionRecorder
from .routes import RouteProgress
from .safety import SafetyError, SafetyEvent, SpeedController
from .storage import Store
from .udp import UdpSender

log = logging.getLogger(__name__)

START_CONFIRM_TIMEOUT_S = 15.0
QUEUE_SIZE = 256


class ControlError(Exception):
    """A control request that cannot be carried out now (maps to HTTP 409)."""


async def wait_until_moving(backend: PadBackend, timeout_s: float = START_CONFIRM_TIMEOUT_S) -> Sample:
    """After start: wait until the belt actually moves (the pad counts down first)."""
    try:
        async with asyncio.timeout(timeout_s):
            async with contextlib.aclosing(backend.samples()) as samples:
                async for sample in samples:
                    if sample.belt is BeltState.RUNNING and sample.speed_kmh > 0:
                        return sample
    except TimeoutError:
        raise BackendError(f"pad did not report the belt running within {timeout_s:g} s") from None
    raise BackendError("connection lost while waiting for the belt to start")


def route_summary(route: dict[str, Any] | None) -> dict[str, Any] | None:
    if route is None:
        return None
    return {k: route[k] for k in ("id", "name", "distance_m", "progress_m", "completed_at")}


def sample_message(
    sample: Sample, t: float, session_id: int | None, route: dict[str, Any] | None = None
) -> dict[str, Any]:
    return {
        "type": "sample",
        "t": round(t, 3),
        "speed_kmh": sample.speed_kmh,
        "distance_m": sample.distance_m,
        "steps": sample.steps,
        "elapsed_s": sample.elapsed_s,
        "belt": str(sample.belt),
        "session_id": session_id,
        # Distance along the active route (persists across sessions), or null.
        "route_id": route["id"] if route else None,
        "route_progress_m": route["progress_m"] if route else None,
    }


class BridgeService:
    def __init__(
        self,
        backend: PadBackend,
        config: Config,
        store: Store,
        *,
        protocol_name: str | None = None,
        clock: Clock | None = None,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        self.backend = backend
        self.config = config
        self.store = store
        self.clock: Clock = clock or MonotonicClock()
        self.wall_clock = wall_clock
        self.recorder = SessionRecorder(
            store, protocol_name, config.storage.min_session_s, wall_clock
        )
        self.controller: SpeedController | None = None
        self.routes = RouteProgress(store, wall_clock)
        self.route: dict[str, Any] | None = store.active_route()
        self.last_sample: Sample | None = None
        self.udp = UdpSender(config.udp.host, config.udp.port) if config.udp.enabled else None
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._clients: Counter[str] = Counter()
        self._grace_tasks: dict[str, asyncio.Task[None]] = {}
        self._start_task: asyncio.Task[None] | None = None
        self._runner: asyncio.Task[None] | None = None
        self._last_error: str | None = None

    # --- lifecycle --------------------------------------------------------------------------

    async def start(self) -> None:
        closed = self.store.close_dangling(self.config.storage.min_session_s)
        if closed:
            log.warning("closed %d session(s) left open by an earlier crash", closed)
        if self.udp is not None:
            await self.udp.start()
        self._runner = asyncio.create_task(self._run(), name="bridge-run")

    async def close(self) -> None:
        """Stop the belt if it runs, disconnect, close the open session."""
        for task in [self._runner, self._start_task, *self._grace_tasks.values()]:
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
        if self.controller is not None:
            try:
                await self.controller.close()
            except BackendError as exc:
                log.critical("could not stop the belt on shutdown: %s", exc)
        elif self.backend.is_connected:
            await self.backend.disconnect()
        self.recorder.end()
        if self.udp is not None:
            self.udp.close()
        self._broadcast(self.status())

    async def _run(self) -> None:
        interval = self.config.server.reconnect_interval_s
        while True:
            try:
                await self._run_once(interval)
            except asyncio.CancelledError:
                raise
            except Exception:
                # Never let the loop die: without it nobody reads the pad or enforces the cap.
                log.exception("bridge loop error; carrying on")
                self.recorder.end()
                await self.clock.sleep(interval)

    async def _run_once(self, interval: float) -> None:
        """Connect if needed, then pass samples on until the pad connection goes away."""
        if not self.backend.is_connected:
            try:
                await self.backend.connect()
            except BackendError as exc:
                if str(exc) != self._last_error:
                    log.warning("pad not reachable, retrying every %g s: %s", interval, exc)
                    self._last_error = str(exc)
                await self.clock.sleep(interval)
                return
            self._last_error = None
            detected = getattr(self.backend, "protocol", None)
            if detected is not None:
                self.recorder.protocol = str(detected)
            log.info("connected to the pad (%s)", self.recorder.protocol)
            if self.controller is None:
                self.controller = SpeedController(self.backend, self.config.safety, self.clock)
                self.controller.add_event_listener(self._on_safety_event)
            else:
                # The belt keeps running when the link drops. If the controller's own recovery
                # gave up, the stop is still owed: send it before anything else. If that fails,
                # drop the link and try again on the next round.
                try:
                    await self.controller.reconnected()
                except BackendError as exc:
                    log.critical("could not send the owed stop: %s", exc)
                    await self.backend.disconnect()
                    await self.clock.sleep(interval)
                    return
            self._broadcast(self.status())
        async with contextlib.aclosing(self.backend.samples()) as samples:
            async for sample in samples:
                self._on_sample(sample)
        # The pad connection went away (the belt may still be running).
        self.recorder.link_lost()
        self._broadcast(self.status())
        if self.controller is not None and self.controller.recovery_task is not None:
            await self.controller.recovery_task  # reconnects and stops the belt
            self.controller.recovery_task = None

    def _on_sample(self, sample: Sample) -> None:
        self.last_sample = sample
        if self.controller is not None:
            self.controller.observe(sample)
        try:
            self.recorder.on_sample(sample)
            moved = self.routes.on_distance(self.recorder.session_id, self.recorder.totals.distance_m)
            if moved is not None:
                self.route = moved
        except Exception:
            log.exception("could not record sample")  # storage trouble must not stop live data
        message = sample_message(sample, self.wall_clock(), self.recorder.session_id, self.route)
        self._broadcast(message)
        if self.udp is not None:
            self.udp.send(message)

    def _on_safety_event(self, event: SafetyEvent) -> None:
        self._broadcast({
            "type": "safety",
            "kind": str(event.kind),
            "message": event.message,
            "speed_kmh": event.speed_kmh,
            "cap_kmh": event.cap_kmh,
        })

    # --- live data --------------------------------------------------------------------------

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=QUEUE_SIZE)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(queue)

    def _broadcast(self, message: dict[str, Any]) -> None:
        for queue in list(self._subscribers):
            if queue.full():
                queue.get_nowait()  # a slow client loses old samples, never blocks the bridge
            queue.put_nowait(message)

    def status(self) -> dict[str, Any]:
        c = self.controller
        s = self.last_sample if self.backend.is_connected else None
        return {
            "type": "status",
            "connected": self.backend.is_connected,
            "protocol": str(getattr(self.backend, "protocol", None) or self.recorder.protocol),
            "belt": str(s.belt) if s else None,
            "speed_kmh": s.speed_kmh if s else None,
            "cap_kmh": c.max_speed_kmh if c else self.config.safety.max_speed_kmh,
            "target_kmh": c.target_kmh if c else None,
            "controlling_client": c.controlling_client if c else None,
            "session_id": self.recorder.session_id,
            "route": route_summary(self.route),
            "error": self._last_error,
        }

    def route_changed(self) -> None:
        """The active route or its progress was changed through the API."""
        self.route = self.store.active_route()
        self._broadcast(self.status())

    # --- clients and control ----------------------------------------------------------------

    def client_connected(self, client: str) -> None:
        """A local WebSocket for `client` opened."""
        self._clients[client] += 1
        task = self._grace_tasks.pop(client, None)
        if task is not None:
            task.cancel()
            log.info("client %r is back within the grace period", client)

    def client_disconnected(self, client: str) -> None:
        self._clients[client] -= 1
        if self._clients[client] > 0:
            return
        del self._clients[client]
        if self.controller is not None and self.controller.controlling_client == client:
            grace = self.config.server.client_grace_s
            log.warning("controlling client %r disconnected; waiting %g s", client, grace)
            self._grace_tasks[client] = asyncio.create_task(self._grace(client))

    def has_client(self, client: str) -> bool:
        return self._clients[client] > 0

    async def _grace(self, client: str) -> None:
        try:
            await self.clock.sleep(self.config.server.client_grace_s)
            if self.has_client(client) or self.controller is None:
                return
            await self.controller.ramp_down_and_stop(client)
        except BackendError as exc:
            log.critical("could not stop the belt after client %r left: %s. STOP THE PAD.",
                         client, exc)
        finally:
            self._grace_tasks.pop(client, None)
            self._broadcast(self.status())

    def _require(self, client: str) -> SpeedController:
        if not self.has_client(client):
            raise ControlError(
                "open the live WebSocket (/live?client=<id>) with this client id before sending "
                "commands, so the belt can be stopped if this client goes away"
            )
        if self.controller is None or not self.backend.is_connected:
            raise ControlError("pad is not connected")
        return self.controller

    async def control_start(self, client: str, kmh: float) -> float:
        """Start the belt; once it moves, ramp to `kmh`. Returns the target after the cap."""
        controller = self._require(client)
        if self.backend.belt_state is not BeltState.STOPPED:
            raise ControlError(f"belt is {self.backend.belt_state}; stop it first or set a speed")
        target = controller.clamp(kmh)
        if target == 0:
            raise ControlError("start needs a speed above 0")
        await controller.start(client=client)
        self._start_task = asyncio.create_task(self._finish_start(controller, client, kmh))
        self._broadcast(self.status())
        return target

    async def _finish_start(self, controller: SpeedController, client: str, kmh: float) -> None:
        try:
            await wait_until_moving(self.backend)
            if controller.controlling_client == client:  # nobody stopped it meanwhile
                await controller.set_speed(kmh, client=client)
        except (BackendError, SafetyError) as exc:
            log.error("start did not complete (%s); stopping the belt", exc)
            with contextlib.suppress(BackendError):
                await controller.stop()
        finally:
            self._broadcast(self.status())

    async def control_speed(self, client: str, kmh: float) -> float:
        controller = self._require(client)
        if self._start_task is not None and not self._start_task.done():
            raise ControlError("the belt is still starting; try again in a moment")
        try:
            target = await controller.set_speed(kmh, client=client)
        except SafetyError as exc:
            raise ControlError(str(exc)) from exc
        self._broadcast(self.status())
        return target

    async def control_stop(self, client: str) -> None:
        """Stop is always allowed for a local client, even without a WebSocket."""
        if self._start_task is not None:
            self._start_task.cancel()
        if self.controller is None or not self.backend.is_connected:
            raise ControlError("pad is not connected")
        await self.controller.stop(client=client)
        self._broadcast(self.status())
