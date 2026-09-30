"""SpeedController: the one and only path for belt speed changes.

Enforces the safety rules from CLAUDE.md:
- speed cap (config) and the device's valid range,
- max ramp rate (config): speed changes are sent in steps no larger than
  `max_ramp_kmh_per_s * ramp_tick_s`, one step per tick,
- stop the belt if the pad connection drops (reconnect, then stop) or if the controlling
  client disconnects.

While the bridge controls the belt (a client started it or set its speed), the controller also
holds the belt to what it commanded, fed by `observe()`:
- right after start it pins the speed the belt is at, so the pad's own run-up to its start-speed
  setting cannot carry it past the cap (seen on the owner's pad: start speed 2.5 km/h),
- if the pad reports more than the commanded speed for HOLD_SAMPLES samples, it ramps back down,
- if the belt stays above the cap for `above_cap_stop_s`, it stops the belt.
No command is ever above the cap: a belt above the cap is first commanded to the cap itself.

When nobody controls the belt (e.g. it was started with the pad's own remote) a belt above the
cap is not forced down; it emits a BELT_ABOVE_CAP safety event so the UI can show it.
"""

from __future__ import annotations

import asyncio
import enum
import logging
import math
from collections.abc import Callable
from dataclasses import dataclass

from .backend import BackendError, BeltState, PadBackend, Sample
from .clock import Clock, MonotonicClock

log = logging.getLogger(__name__)

HOLD_SAMPLES = 2  # consecutive samples above the commanded speed before correcting


@dataclass(frozen=True, slots=True)
class SafetyConfig:
    max_speed_kmh: float = 6.0
    max_ramp_kmh_per_s: float = 0.5
    ramp_tick_s: float = 1.0
    reconnect_attempts: int = 3
    reconnect_backoff_s: float = 1.0
    above_cap_stop_s: float = 5.0

    def __post_init__(self) -> None:
        for name in ("max_speed_kmh", "max_ramp_kmh_per_s", "ramp_tick_s", "above_cap_stop_s"):
            value = getattr(self, name)
            if not (math.isfinite(value) and value > 0):
                raise ValueError(f"safety.{name} must be a positive number, got {value!r}")
        if self.reconnect_attempts < 1:
            raise ValueError("safety.reconnect_attempts must be at least 1")
        if self.reconnect_backoff_s < 0:
            raise ValueError("safety.reconnect_backoff_s must not be negative")


class SafetyEventKind(enum.StrEnum):
    BELT_ABOVE_CAP = "belt_above_cap"
    BELT_WITHIN_CAP = "belt_within_cap"  # the above-cap condition cleared
    FAILSAFE_STOP = "failsafe_stop"  # stayed above the cap under bridge control: stopped


@dataclass(frozen=True, slots=True)
class SafetyEvent:
    kind: SafetyEventKind
    message: str
    speed_kmh: float
    cap_kmh: float


class SafetyError(Exception):
    pass


class BeltNotRunningError(SafetyError):
    pass


class ConnectionLostError(SafetyError):
    pass


class SpeedController:
    """Wraps a PadBackend. Speeds are handled internally in integer device-resolution units."""

    def __init__(
        self, backend: PadBackend, config: SafetyConfig, clock: Clock | None = None
    ) -> None:
        self.backend = backend
        self.config = config
        self.clock: Clock = clock or MonotonicClock()

        rng = backend.speed_range
        self._res = rng.resolution_kmh
        self._min_units = math.ceil(rng.min_kmh / self._res - 1e-9)
        self._max_units = math.floor(min(config.max_speed_kmh, rng.max_kmh) / self._res + 1e-9)
        if self._max_units < self._min_units:
            raise ValueError(
                f"max_speed_kmh {config.max_speed_kmh} is below the device minimum {rng.min_kmh}"
            )
        self._max_step_units = math.floor(
            config.max_ramp_kmh_per_s * config.ramp_tick_s / self._res + 1e-9
        )
        if self._max_step_units < 1:
            raise ValueError(
                "max_ramp_kmh_per_s * ramp_tick_s is smaller than the device speed resolution "
                f"({self._res} km/h); use a longer ramp_tick_s"
            )

        self._target_units: int | None = None
        self._commanded_units: int | None = None
        self._ramp_task: asyncio.Task[None] | None = None
        self._controlling_client: str | None = None
        self._connection_lost = False
        self._above_cap = False
        self._event_listeners: list[Callable[[SafetyEvent], None]] = []
        self._command_listeners: list[Callable[[str, float | None], None]] = []
        self._pin_on_ramp = False  # set by start(): first ramp step pins the actual speed
        self._over_commanded = 0
        self._above_cap_since: float | None = None
        self._failsafe_task: asyncio.Task[None] | None = None
        self.recovery_task: asyncio.Task[bool] | None = None
        backend.add_connection_lost_listener(self._on_connection_lost)

    @property
    def max_speed_kmh(self) -> float:
        """Effective cap: the lower of the configured cap and the device maximum."""
        return self._kmh(self._max_units)

    @property
    def target_kmh(self) -> float | None:
        return None if self._target_units is None else self._kmh(self._target_units)

    @property
    def controlling_client(self) -> str | None:
        return self._controlling_client

    @property
    def belt_above_cap(self) -> bool:
        return self._above_cap

    def add_event_listener(self, callback: Callable[[SafetyEvent], None]) -> None:
        """`callback` receives SafetyEvents (e.g. for pushing to the UI)."""
        self._event_listeners.append(callback)

    def add_command_listener(self, callback: Callable[[str, float | None], None]) -> None:
        """`callback(name, kmh)` runs after every command sent to the pad (for lag metering).

        Names: "start", "set_speed" (with kmh), "stop".
        """
        self._command_listeners.append(callback)

    def observe(self, sample: Sample) -> None:
        """Feed every live sample here: detects above-cap belts and holds a controlled belt."""
        self._check_cap(sample.speed_kmh)
        self._hold(sample)

    def clamp(self, kmh: float) -> float:
        """The speed a request would actually be clamped to. Raises on nonsense input."""
        return self._kmh(self._to_units(kmh))

    async def start(self, client: str | None = None) -> None:
        self._check_usable()
        self._claim(client)
        await self.backend.start()
        self._sent("start")
        # Real pads run up to their own start-speed setting, which may be above the cap. The
        # next ramp begins from the speed the pad reports and pins it at once (see _ramp).
        self._commanded_units = None
        self._target_units = None
        self._pin_on_ramp = True

    async def set_speed(self, kmh: float, client: str | None = None) -> float:
        """Ramp towards `kmh` (clamped to cap and device range). Returns the effective target.

        Returns immediately; use `wait_until_reached()` to wait for the ramp. 0 means stop.
        """
        self._check_usable()
        if kmh == 0:
            await self.stop(client)
            return 0.0
        units = self._to_units(kmh)
        if self.backend.belt_state is not BeltState.RUNNING:
            raise BeltNotRunningError("belt is not running; start it first")
        if abs(self._kmh(units) - kmh) > 1e-9:
            log.warning("requested %.2f km/h, clamped to %.1f km/h", kmh, self._kmh(units))
        self._claim(client)
        self._target_units = units
        if self._ramp_task is None or self._ramp_task.done():
            self._ramp_task = asyncio.create_task(self._ramp())
        return self._kmh(units)

    async def wait_until_reached(self) -> None:
        if self._ramp_task is not None:
            await self._ramp_task

    async def stop(self, client: str | None = None) -> None:
        """Stop the belt now. Always allowed (no ramp; the pad decelerates on its own)."""
        await self._cancel_ramp()
        self._claim(client)
        await self.backend.stop()
        self._sent("stop")

    async def client_disconnected(self, client: str) -> None:
        """Call when a client goes away. Stops the belt if that client was in control."""
        if client != self._controlling_client:
            return
        self._controlling_client = None
        if self.backend.is_connected and self.backend.belt_state is not BeltState.STOPPED:
            log.warning("controlling client %r disconnected; stopping belt", client)
            await self.stop()

    async def ramp_down_and_stop(self, client: str) -> None:
        """The controlling `client` is gone for good: ramp down to the device minimum at the
        ramp rate, then stop. Control is released first, so if any client takes control during
        the ramp-down (sets a speed, starts, stops), this backs off and leaves the belt to it.
        """
        if client != self._controlling_client:
            return
        self._controlling_client = None
        if not self.backend.is_connected or self._connection_lost:
            return  # the connection-lost recovery stops the belt
        if self.backend.belt_state is not BeltState.RUNNING:
            if self.backend.belt_state is not BeltState.STOPPED:
                await self.stop()
            return
        log.warning("controlling client %r gone; ramping down to a stop", client)
        try:
            if self.backend.speed_kmh > self._kmh(self._min_units) + self._res / 2:
                await self.set_speed(self._kmh(self._min_units))
                await self.wait_until_reached()
        except (BackendError, SafetyError) as exc:
            log.error("ramp-down failed (%s); stopping at once", exc)
        except asyncio.CancelledError:
            task = asyncio.current_task()
            if task is not None and task.cancelling():
                raise  # we ourselves are being cancelled
            # Otherwise the ramp we waited on was cancelled (someone stopped the belt).
        if self._controlling_client is None:
            await self.stop()

    async def close(self) -> None:
        """Stop the belt if needed and disconnect."""
        await self._cancel_ramp()
        if self.backend.is_connected:
            try:
                if self.backend.belt_state is not BeltState.STOPPED:
                    await self.backend.stop()
                    self._sent("stop")
            except BackendError:
                log.critical("could not send stop while closing. STOP THE PAD MANUALLY.")
                raise
            finally:
                await self.backend.disconnect()

    # --- internals --------------------------------------------------------------------------

    def _kmh(self, units: int) -> float:
        return round(units * self._res, 6)

    def _to_units(self, kmh: float) -> int:
        if not math.isfinite(kmh) or kmh < 0:
            raise ValueError(f"invalid speed {kmh!r}")
        return max(self._min_units, min(self._max_units, round(kmh / self._res)))

    def _check_usable(self) -> None:
        if self._connection_lost:
            raise ConnectionLostError("pad connection lost; waiting for recovery")

    def _claim(self, client: str | None) -> None:
        if client is not None:
            self._controlling_client = client

    def _check_cap(self, speed_kmh: float) -> None:
        above = speed_kmh > self.max_speed_kmh + self._res / 2
        if above == self._above_cap:
            return  # report transitions only, not every sample
        self._above_cap = above
        cap = self.max_speed_kmh
        if above:
            kind = SafetyEventKind.BELT_ABOVE_CAP
            message = f"belt at {speed_kmh:.1f} km/h is above the {cap:.1f} km/h cap"
            log.warning(message)
        else:
            kind = SafetyEventKind.BELT_WITHIN_CAP
            message = f"belt back within the {cap:.1f} km/h cap"
            log.info(message)
        self._emit(SafetyEvent(kind, message, speed_kmh, cap))

    def _hold(self, sample: Sample) -> None:
        controlled = self._controlling_client is not None and not self._connection_lost
        if not controlled or sample.belt is not BeltState.RUNNING:
            self._over_commanded = 0
            self._above_cap_since = None
            return
        now = self.clock.now()
        if not self._above_cap:
            self._above_cap_since = None
        elif self._above_cap_since is None:
            self._above_cap_since = now
        elif (
            now - self._above_cap_since >= self.config.above_cap_stop_s
            and self._failsafe_task is None
        ):
            message = (
                f"belt still at {sample.speed_kmh:.1f} km/h, above the {self.max_speed_kmh:.1f} "
                f"km/h cap, after {self.config.above_cap_stop_s:g} s under bridge control; stopping"
            )
            log.critical(message)
            self._emit(SafetyEvent(SafetyEventKind.FAILSAFE_STOP, message, sample.speed_kmh,
                                   self.max_speed_kmh))
            self._failsafe_task = asyncio.get_running_loop().create_task(self._failsafe_stop())
            return

        ramping = self._ramp_task is not None and not self._ramp_task.done()
        if ramping or self._commanded_units is None or self._target_units is None:
            self._over_commanded = 0
            return
        commanded = self._kmh(self._commanded_units)
        if sample.speed_kmh > commanded + self._res / 2:
            self._over_commanded += 1
        else:
            self._over_commanded = 0
        if self._over_commanded >= HOLD_SAMPLES:
            log.warning("pad reports %.1f km/h, above the commanded %.1f; correcting",
                        sample.speed_kmh, commanded)
            self._over_commanded = 0
            self._commanded_units = None  # ramp again from the actual speed
            self._ramp_task = asyncio.get_running_loop().create_task(self._ramp())

    async def _failsafe_stop(self) -> None:
        try:
            await self.stop()
        except (BackendError, SafetyError) as exc:
            log.critical("failsafe stop failed: %s. STOP THE PAD MANUALLY.", exc)
        finally:
            self._failsafe_task = None

    def _emit(self, event: SafetyEvent) -> None:
        for callback in list(self._event_listeners):
            try:
                callback(event)
            except Exception:
                log.exception("safety event listener failed")

    def _sent(self, name: str, kmh: float | None = None) -> None:
        for callback in list(self._command_listeners):
            try:
                callback(name, kmh)
            except Exception:
                log.exception("command listener failed")

    async def _ramp(self) -> None:
        self._check_cap(self.backend.speed_kmh)
        if self._commanded_units is None:
            # Just started, or already running when we took over: ramp from its actual speed,
            # clamped into [device min, cap]. Never command above the cap.
            actual = round(self.backend.speed_kmh / self._res)
            start = max(self._min_units, min(self._max_units, actual))
            pin, self._pin_on_ramp = self._pin_on_ramp, False
            if pin and self._target_units is not None:
                # Pin one ramp step towards the target (from the actual speed) rather than the
                # actual speed itself: on the owner's pad that avoids a down-then-up wobble.
                diff = self._target_units - start
                start += max(-self._max_step_units, min(self._max_step_units, diff))
            self._commanded_units = start
            if pin or actual > self._max_units:
                # After our own start, or above the cap: command it now, not after a tick.
                await self.backend.set_speed(self._kmh(start))
                self._sent("set_speed", self._kmh(start))
        while self._target_units is not None and self._commanded_units != self._target_units:
            await self.clock.sleep(self.config.ramp_tick_s)
            if self._target_units is None:
                break
            diff = self._target_units - self._commanded_units
            step = max(-self._max_step_units, min(self._max_step_units, diff))
            next_units = self._commanded_units + step
            await self.backend.set_speed(self._kmh(next_units))
            self._commanded_units = next_units
            self._sent("set_speed", self._kmh(next_units))

    async def _cancel_ramp(self) -> None:
        self._target_units = None
        self._commanded_units = None
        self._pin_on_ramp = False
        task, self._ramp_task = self._ramp_task, None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    def _on_connection_lost(self) -> None:
        log.error("pad connection lost; will reconnect and stop the belt")
        self._connection_lost = True
        self._target_units = None
        self._commanded_units = None
        if self._ramp_task is not None:
            self._ramp_task.cancel()
            self._ramp_task = None
        self.recovery_task = asyncio.get_running_loop().create_task(self._recover())

    async def _recover(self) -> bool:
        attempts = self.config.reconnect_attempts
        for attempt in range(1, attempts + 1):
            try:
                await self.backend.connect()
                # Belt state is stale after a drop, so always send stop.
                await self.backend.stop()
                self._sent("stop")
            except BackendError as exc:
                log.error("reconnect attempt %d/%d failed: %s", attempt, attempts, exc)
                if attempt < attempts:
                    await self.clock.sleep(self.config.reconnect_backoff_s * attempt)
                continue
            self._connection_lost = False
            self._controlling_client = None
            log.warning("reconnected to pad and stopped the belt")
            return True
        # The stop stays owed: whoever reconnects next must call reconnected() (the service's
        # reconnect loop does), which sends it before anything else.
        log.critical("could not reconnect to stop the belt. STOP THE PAD MANUALLY. "
                     "The stop will be sent as soon as the pad is reachable again.")
        return False

    @property
    def stop_owed(self) -> bool:
        """The connection dropped and no stop has reached the pad since."""
        return self._connection_lost

    async def reconnected(self) -> None:
        """Call after reconnecting the backend yourself. Sends the stop still owed from a lost
        connection (the belt keeps running when the link drops); no-op otherwise.
        Raises BackendError if the stop cannot be sent; the stop then stays owed.
        """
        if not self._connection_lost:
            return
        if self.recovery_task is not None and not self.recovery_task.done():
            return  # recovery is still trying; it sends the stop itself
        await self.backend.stop()
        self._sent("stop")
        self._connection_lost = False
        self._controlling_client = None
        log.warning("pad reachable again: sent the stop owed since the connection was lost")
