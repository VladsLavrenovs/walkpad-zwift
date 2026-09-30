"""KingSmith proprietary WalkingPad protocol (read-only). Reference: ph4-walkingpad (MIT).

Frames: host -> pad `F7 <payload> <crc> FD`, pad -> host `F8 <payload> <crc> FD`, where crc is
the sum of the payload bytes mod 256. The pad only reports status when asked, so we write the
status query to FE02 once per poll interval and decode the `F8 A2` status replies on FE01.

The status query is the only thing this module ever writes. Speed/start/stop frames exist in
the protocol but are deliberately not implemented yet.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable
from dataclasses import dataclass

from .backend import BeltState, Sample, SpeedRange
from .ble import KS_NOTIFY_CHAR, KS_WRITE_CHAR, GattClient, Protocol, ProtocolHandler
from .clock import Clock, MonotonicClock

log = logging.getLogger(__name__)

# Real range depends on the model (A1: 0.5-6, R1/R2 up to 10); unused until control lands.
DEFAULT_SPEED_RANGE = SpeedRange(min_kmh=0.5, max_kmh=6.0, resolution_kmh=0.1)

# Raw belt_state values seen in ph4-walkingpad and the community.
STATE_IDLE = 0
STATE_RUNNING = 1
STATE_STANDBY = 5
STATE_STARTING = 9  # start countdown on the pad's display
KNOWN_STATES = {STATE_IDLE, STATE_RUNNING, STATE_STANDBY, STATE_STARTING}

STATUS_LEN = 17  # bytes up to and including the controller button (index 16)


def build_frame(payload: bytes) -> bytes:
    return bytes([0xF7, *payload, sum(payload) % 256, 0xFD])


STATUS_QUERY = build_frame(bytes([0xA2, 0x00, 0x00]))  # F7 A2 00 00 A2 FD


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
        if self.belt_state in (STATE_RUNNING, STATE_STARTING):
            return BeltState.RUNNING  # a starting belt is about to move: treat as running
        return BeltState.STOPPING if self.speed_kmh > 0 else BeltState.STOPPED

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

    async def start(self, client: GattClient, publish: Callable[[Sample], None]) -> None:
        self._publish = publish
        await client.start_notify(KS_NOTIFY_CHAR, self._on_notify)
        self._poller = asyncio.create_task(self._poll(client))

    async def stop(self) -> None:
        task, self._poller = self._poller, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

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
        if status.belt_state not in KNOWN_STATES and status.belt_state not in self._warned_states:
            self._warned_states.add(status.belt_state)
            log.warning("unknown KingSmith belt state %d (raw %s)", status.belt_state, raw.hex(" "))
        if self._publish is not None:
            self._publish(status.to_sample())

    async def _poll(self, client: GattClient) -> None:
        while True:
            try:
                # Without response, as ph4-walkingpad does (old bleak's default).
                await client.write_gatt_char(KS_WRITE_CHAR, STATUS_QUERY, response=False)
            except Exception as exc:  # a dropped link is reported by the disconnect callback
                log.debug("status query failed: %s", exc)
            await self.clock.sleep(self.poll_interval_s)
