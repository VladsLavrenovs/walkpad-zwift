"""KingSmith proprietary WalkingPad protocol. Reference: ph4-walkingpad (MIT).

Frames: host -> pad `F7 <payload> <crc> FD`, pad -> host `F8 <payload> <crc> FD`, where crc is
the sum of the payload bytes mod 256. The pad only reports status when asked, so we write the
status query to FE02 once per poll interval and decode the `F8 A2` status replies on FE01.

Belt commands (only ever reached through SpeedController -> BleBackend):
- start: switch to manual mode `A2 02 01`, wait, then `A2 04 01`. ph4-walkingpad warns that
  start acts like a toggle on some pads, so BleBackend only starts a belt it knows is stopped.
  The mode switch is always sent (a bare start was ignored after a long idle).
- speed: `A2 01 <km/h * 10>`.  stop: speed 0.

All writes, status queries included, go through one lock with a minimum gap between them,
because the pad drops commands that arrive too close together.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable
from dataclasses import dataclass

from .backend import BackendError, BeltState, Sample, SpeedRange
from .ble import KS_NOTIFY_CHAR, KS_WRITE_CHAR, GattClient, Protocol, ProtocolHandler
from .clock import Clock, MonotonicClock

log = logging.getLogger(__name__)

# Real range depends on the model (A1: 0.5-6, R1/R2 up to 10); unused until control lands.
DEFAULT_SPEED_RANGE = SpeedRange(min_kmh=0.5, max_kmh=6.0, resolution_kmh=0.1)

# Raw belt_state values. Seen on the owner's pad: 5 standby, 0 idle in manual mode, start
# counts down 9 -> 8 -> 7 -> 1 (running).
STATE_IDLE = 0
STATE_RUNNING = 1
STATE_STANDBY = 5
STATES_STARTING = {7, 8, 9}  # start countdown on the pad's display
STATES_STOPPED = {STATE_IDLE, STATE_STANDBY}
KNOWN_STATES = {STATE_RUNNING, *STATES_STARTING, *STATES_STOPPED}

STATUS_LEN = 17  # bytes up to and including the controller button (index 16)

MODE_MANUAL = 1
# ph4-walkingpad keeps >= 0.69 s between commands but its own spacing code is loose; 0.5 s
# leaves room for one status query and one ramp step per second.
MIN_WRITE_GAP_S = 0.5
MODE_SWITCH_SETTLE_S = 1.5  # ph4-walkingpad waits this long after switching mode


def build_frame(payload: bytes) -> bytes:
    return bytes([0xF7, *payload, sum(payload) % 256, 0xFD])


STATUS_QUERY = build_frame(bytes([0xA2, 0x00, 0x00]))  # F7 A2 00 00 A2 FD
START_BELT = build_frame(bytes([0xA2, 0x04, 0x01]))
MANUAL_MODE = build_frame(bytes([0xA2, 0x02, MODE_MANUAL]))


def speed_frame(kmh: float) -> bytes:
    units = round(kmh * 10)
    if not 0 <= units <= 0xFF:
        raise ValueError(f"speed {kmh} km/h cannot be encoded")
    return build_frame(bytes([0xA2, 0x01, units]))


def _uint24(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset : offset + 3], "big")


@dataclass(frozen=True, slots=True)
class KsStatus:
    """Decoded `F8 A2` status frame. Counters are for the current session."""

    belt_state: int
    speed_kmh: float
    mode: int  # 0 auto, 1 manual, 2 standby
    elapsed_s: int
    distance_m: int  # the pad counts in 10 m units
    steps: int

    @property
    def belt(self) -> BeltState:
        if self.belt_state == STATE_RUNNING or self.belt_state in STATES_STARTING:
            return BeltState.RUNNING  # a starting belt is about to move: treat as running
        if self.belt_state in STATES_STOPPED:
            return BeltState.STOPPING if self.speed_kmh > 0 else BeltState.STOPPED
        # Unknown state: never call it stopped (start must not be sent, stop not confirmed).
        return BeltState.RUNNING if self.speed_kmh > 0 else BeltState.STOPPING

    def to_sample(self) -> Sample:
        return Sample(
            speed_kmh=self.speed_kmh,
            distance_m=float(self.distance_m),
            steps=self.steps,
            elapsed_s=float(self.elapsed_s),
            belt=self.belt,
        )


def parse_status(data: bytes) -> KsStatus | None:
    """Decode a status frame; None for other message types. Raises ValueError if truncated."""
    if len(data) < 2 or data[0] != 0xF8 or data[1] != 0xA2:
        return None
    if len(data) < STATUS_LEN:
        raise ValueError(f"status frame too short ({len(data)} bytes): {data.hex(' ')}")
    # Checksum layout confirmed on a real pad (firmware M30_V187.2.0).
    if data[-1] != 0xFD or data[-2] != sum(data[1:-2]) % 256:
        raise ValueError(f"status frame has a bad checksum or trailer: {data.hex(' ')}")
    return KsStatus(
        belt_state=data[2],
        speed_kmh=data[3] / 10,
        mode=data[4],
        elapsed_s=_uint24(data, 5),
        distance_m=_uint24(data, 8) * 10,
        steps=_uint24(data, 11),
    )


class KingsmithProtocol(ProtocolHandler):
    protocol = Protocol.KINGSMITH

    def __init__(self, poll_interval_s: float = 1.0, clock: Clock | None = None) -> None:
        # ph4-walkingpad keeps >= 0.69 s between commands; polling faster gains nothing.
        if poll_interval_s < 0.5:
            raise ValueError("KingSmith poll interval must be at least 0.5 s")
        self.poll_interval_s = poll_interval_s
        self.clock: Clock = clock or MonotonicClock()
        self.speed_range = DEFAULT_SPEED_RANGE
        self._poller: asyncio.Task[None] | None = None
        self._publish: Callable[[Sample], None] | None = None
        self._warned_states: set[int] = set()
        self._client: GattClient | None = None
        self._write_lock = asyncio.Lock()
        self._last_write: float | None = None
        self.last_status: KsStatus | None = None

    async def start(self, client: GattClient, publish: Callable[[Sample], None]) -> None:
        self._publish = publish
        self._client = client
        await client.start_notify(KS_NOTIFY_CHAR, self._on_notify)
        self._poller = asyncio.create_task(self._poll())

    async def stop(self) -> None:
        task, self._poller = self._poller, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def start_belt(self) -> None:
        # Always switch to manual mode first, as ph4-walkingpad does. Skipping it when the status
        # already said manual worked a few minutes after a stop, but after ~10 min idle the
        # owner's pad ignored the bare start (2026-09-30).
        await self._send(MANUAL_MODE, "manual mode")
        await self.clock.sleep(MODE_SWITCH_SETTLE_S)
        await self._send(START_BELT, "start")

    async def stop_belt(self) -> None:
        await self._send(speed_frame(0), "stop")

    async def set_belt_speed(self, kmh: float) -> None:
        await self._send(speed_frame(kmh), f"speed {kmh:.1f}")

    def _on_notify(self, _char: object, data: bytearray) -> None:
        raw = bytes(data)
        log.debug("KS rx %s", raw.hex(" "))
        try:
            status = parse_status(raw)
        except ValueError as exc:
            log.warning("dropping KingSmith frame: %s", exc)
            return
        if status is None:
            return  # e.g. F8 A7 last-session record; not needed for live data
        self.last_status = status
        if status.belt_state not in KNOWN_STATES and status.belt_state not in self._warned_states:
            self._warned_states.add(status.belt_state)
            log.warning("unknown KingSmith belt state %d (raw %s)", status.belt_state, raw.hex(" "))
        if self._publish is not None:
            self._publish(status.to_sample())

    async def _send(self, frame: bytes, what: str) -> None:
        """Write one frame, keeping MIN_WRITE_GAP_S since the previous write. Raises BackendError."""
        if self._client is None:
            raise BackendError("KingSmith handler is not started")
        async with self._write_lock:
            if self._last_write is not None:
                wait = self._last_write + MIN_WRITE_GAP_S - self.clock.now()
                if wait > 0:
                    await self.clock.sleep(wait)
            if what != "status":
                log.info("KS tx %s: %s", what, frame.hex(" "))
            try:
                # Without response, as ph4-walkingpad does (old bleak's default); FE02 on the
                # owner's pad supports nothing else.
                await self._client.write_gatt_char(KS_WRITE_CHAR, frame, response=False)
            except Exception as exc:
                raise BackendError(f"KingSmith {what} write failed: {exc}") from exc
            finally:
                self._last_write = self.clock.now()

    async def _poll(self) -> None:
        while True:
            try:
                await self._send(STATUS_QUERY, "status")
            except BackendError as exc:  # a dropped link is reported by the disconnect callback
                log.debug("%s", exc)
            await self.clock.sleep(self.poll_interval_s)
