"""Real pad over BLE. Picks the KingSmith or FTMS protocol from the services the pad offers.

Belt commands are for SpeedController only (it enforces cap and ramp). On top of that this
backend refuses commands that make no sense for the last reported belt state:
- `start` only when the pad reported a stopped belt (on some pads start is a toggle),
- `set_speed` only while the pad reports the belt running, within the device range,
- `stop` is always sent.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator

from . import ble
from .backend import BackendError, BeltState, NotConnectedError, PadBackend, Sample, SpeedRange
from .ble import Connector, GattClient, Protocol, ProtocolHandler
from .clock import Clock, MonotonicClock
from .ftms import FtmsProtocol
from .kingsmith import KingsmithProtocol

log = logging.getLogger(__name__)


class BleBackend(PadBackend):
    def __init__(
        self,
        address: str,
        *,
        protocol: Protocol | None = None,
        connect_timeout_s: float = 20.0,
        kingsmith_poll_s: float = 1.0,
        connector: Connector | None = None,
        clock: Clock | None = None,
    ) -> None:
        super().__init__()
        self.address = address
        self.requested_protocol = protocol
        self.connect_timeout_s = connect_timeout_s
        self.kingsmith_poll_s = kingsmith_poll_s
        self._connector: Connector = connector or ble.connect_client
        self.clock: Clock = clock or MonotonicClock()
        self.handler: ProtocolHandler | None = None
        self._client: GattClient | None = None
        self._generation = 0
        self._last: Sample | None = None
        self._subscribers: set[asyncio.Queue[Sample | None]] = set()
        self._connect_lock = asyncio.Lock()

    @property
    def protocol(self) -> Protocol | None:
        """The protocol in use (None before the first connect)."""
        return None if self.handler is None else self.handler.protocol

    @property
    def speed_range(self) -> SpeedRange:  # type: ignore[override]
        if self.handler is None:
            raise NotConnectedError("speed range is known only after connecting")
        return self.handler.speed_range

    # --- PadBackend -------------------------------------------------------------------------

    @property
    def is_connected(self) -> bool:
        return self._client is not None

    @property
    def belt_state(self) -> BeltState:
        return BeltState.STOPPED if self._last is None else self._last.belt

    @property
    def speed_kmh(self) -> float:
        return 0.0 if self._last is None else self._last.speed_kmh

    async def connect(self) -> None:
        # The service's reconnect loop and SpeedController's recovery may both try: one link only.
        async with self._connect_lock:
            await self._connect()

    async def _connect(self) -> None:
        if self._client is not None:
            return
        self._generation += 1
        generation = self._generation
        client = await self._connector(
            self.address, self.connect_timeout_s, lambda: self._on_disconnected(generation)
        )
        try:
            uuids = ble.service_uuids(client)
            log.info("services: %s", ", ".join(uuids))
            # Once chosen, stick with a protocol across reconnects.
            protocol = ble.choose_protocol(uuids, self.requested_protocol or self.protocol)
            handler = self._make_handler(protocol)
            await handler.start(client, self._publish)
        except Exception as exc:
            with contextlib.suppress(Exception):
                await client.disconnect()
            if isinstance(exc, BackendError):
                raise
            raise BackendError(f"could not start live data: {exc}") from exc
        if generation != self._generation:  # dropped while we were setting up
            await handler.stop()
            # Close it anyway: a spurious drop report (e.g. a late one from an earlier link)
            # would otherwise leave BlueZ holding a live link nobody uses, and a connected pad
            # stops advertising, so every later connect fails with "not found" (seen on hardware).
            with contextlib.suppress(Exception):
                await client.disconnect()
            raise BackendError("connection dropped during setup")
        self.handler = handler
        self._client = client
        log.info("connected to %s using %s", self.address, protocol)

    async def disconnect(self) -> None:
        client = self._client
        self._generation += 1  # the disconnect callback for this client is now stale
        await self._go_offline()
        if client is not None:
            with contextlib.suppress(Exception):
                await client.disconnect()

    async def samples(self) -> AsyncIterator[Sample]:
        if self._client is None:
            raise NotConnectedError("pad is not connected")
        queue: asyncio.Queue[Sample | None] = asyncio.Queue(maxsize=256)
        self._subscribers.add(queue)
        try:
            if self._last is not None:
                yield self._last
            while (item := await queue.get()) is not None:
                yield item
        finally:
            self._subscribers.discard(queue)

    async def set_speed(self, kmh: float) -> None:
        handler = self._require_handler()
        rng = handler.speed_range
        if not (rng.min_kmh <= kmh <= rng.max_kmh):
            raise ValueError(f"{kmh} km/h outside device range {rng.min_kmh}-{rng.max_kmh}")
        if self.belt_state is not BeltState.RUNNING:
            raise BackendError(f"belt is not running (pad reports {self.belt_state})")
        await handler.set_belt_speed(kmh)

    async def start(self) -> None:
        handler = self._require_handler()
        if self._last is None:
            raise BackendError("no status from the pad yet; refusing to start blind")
        if self._last.belt is not BeltState.STOPPED or self._last.speed_kmh > 0:
            # Start may toggle the belt on some pads, so never send it to a moving belt.
            raise BackendError(f"belt is not stopped (pad reports {self._last.belt})")
        await handler.start_belt()

    async def stop(self) -> None:
        await self._require_handler().stop_belt()

    # --- internals --------------------------------------------------------------------------

    def _require_handler(self) -> ProtocolHandler:
        if self._client is None or self.handler is None:
            raise NotConnectedError("pad is not connected")
        return self.handler

    def _make_handler(self, protocol: Protocol) -> ProtocolHandler:
        if protocol is Protocol.KINGSMITH:
            return KingsmithProtocol(self.kingsmith_poll_s, self.clock)
        return FtmsProtocol(self.clock)

    def _publish(self, item: Sample | None) -> None:
        if item is not None:
            self._last = item
        for queue in list(self._subscribers):
            if queue.full():
                queue.get_nowait()  # drop the oldest; a slow reader must not block BLE
            queue.put_nowait(item)

    async def _go_offline(self) -> None:
        self._client = None
        handler = self.handler
        if handler is not None:
            await handler.stop()
        self._publish(None)

    def _on_disconnected(self, generation: int) -> None:
        if generation != self._generation:
            return  # deliberate disconnect, or a client we already replaced
        self._generation += 1
        if self._client is None:
            return  # still setting up: connect() notices the new generation and raises
        log.error("lost BLE connection to %s", self.address)
        self._client = None
        self._publish(None)
        if self.handler is not None:
            asyncio.get_running_loop().create_task(self.handler.stop())
        self._notify_connection_lost()

