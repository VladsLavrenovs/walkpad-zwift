"""Bluetooth Fitness Machine Service (FTMS, 0x1826) treadmill support (read-only).

Live data arrives as Treadmill Data (0x2ACD) notifications. Nothing is ever written: the
Control Point (0x2AD9) is needed only for speed control, which is not implemented for real
devices yet. FTMS has no step count, so samples carry `steps=None`.
"""

from __future__ import annotations

import logging
import struct
from collections.abc import Callable
from dataclasses import dataclass

from .backend import BeltState, Sample, SpeedRange
from .ble import (
    FTMS_SPEED_RANGE_CHAR,
    FTMS_TREADMILL_DATA_CHAR,
    GattClient,
    Protocol,
    ProtocolHandler,
)
from .clock import Clock, MonotonicClock

log = logging.getLogger(__name__)

DEFAULT_SPEED_RANGE = SpeedRange(min_kmh=0.5, max_kmh=6.0, resolution_kmh=0.1)

# Treadmill Data flags (FTMS spec 4.9.1). Bit 0 is inverted: 0 means speed IS present.
MORE_DATA = 1 << 0
AVERAGE_SPEED = 1 << 1
TOTAL_DISTANCE = 1 << 2
INCLINATION = 1 << 3
ELEVATION_GAIN = 1 << 4
INSTANT_PACE = 1 << 5
AVERAGE_PACE = 1 << 6
EXPENDED_ENERGY = 1 << 7
HEART_RATE = 1 << 8
METABOLIC_EQUIVALENT = 1 << 9
ELAPSED_TIME = 1 << 10
REMAINING_TIME = 1 << 11
FORCE_AND_POWER = 1 << 12

# Fields we skip, in spec order, with their sizes in bytes.
_SKIPPED_BEFORE_DISTANCE = ((AVERAGE_SPEED, 2),)
_SKIPPED_BEFORE_ELAPSED = (
    (INCLINATION, 4),
    (ELEVATION_GAIN, 4),
    (INSTANT_PACE, 1),
    (AVERAGE_PACE, 1),
    (EXPENDED_ENERGY, 5),
    (HEART_RATE, 1),
    (METABOLIC_EQUIVALENT, 1),
)


@dataclass(frozen=True, slots=True)
class TreadmillData:
    """Fields from one notification; None when that notification did not carry them."""

    speed_kmh: float | None = None
    distance_m: int | None = None
    elapsed_s: int | None = None


class _Reader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0

    def take(self, fmt: str) -> int:
        size = struct.calcsize(fmt)
        if self.pos + size > len(self.data):
            raise ValueError(f"treadmill data truncated at byte {self.pos}: {self.data.hex(' ')}")
        (value,) = struct.unpack_from(fmt, self.data, self.pos)
        self.pos += size
        return value

    def uint24(self) -> int:
        low = self.take("<H")
        return low | self.take("<B") << 16

    def skip(self, size: int) -> None:
        if self.pos + size > len(self.data):
            raise ValueError(f"treadmill data truncated at byte {self.pos}: {self.data.hex(' ')}")
        self.pos += size


def parse_treadmill_data(data: bytes) -> TreadmillData:
    r = _Reader(data)
    flags = r.take("<H")
    speed = None if flags & MORE_DATA else r.take("<H") / 100
    for flag, size in _SKIPPED_BEFORE_DISTANCE:
        if flags & flag:
            r.skip(size)
    distance = r.uint24() if flags & TOTAL_DISTANCE else None
    for flag, size in _SKIPPED_BEFORE_ELAPSED:
        if flags & flag:
            r.skip(size)
    elapsed = r.take("<H") if flags & ELAPSED_TIME else None
    return TreadmillData(speed_kmh=speed, distance_m=distance, elapsed_s=elapsed)


def parse_speed_range(data: bytes) -> SpeedRange:
    """Supported Speed Range (0x2AD4): min, max, increment as uint16 in 0.01 km/h."""
    if len(data) < 6:
        raise ValueError(f"speed range too short: {data.hex(' ')}")
    lo, hi, step = struct.unpack_from("<HHH", data)
    if not (0 < lo <= hi) or step == 0:
        raise ValueError(f"implausible speed range {lo}/{hi}/{step} (0.01 km/h units)")
    return SpeedRange(min_kmh=lo / 100, max_kmh=hi / 100, resolution_kmh=step / 100)


class FtmsSession:
    """Folds notifications into Samples.

    Devices may split data over several notifications, so the last value of each field is
    kept. Distance and elapsed time come from the device when it sends them; otherwise they
    are integrated locally from speed and reset when the belt starts from standstill.
    """

    def __init__(self, clock: Clock) -> None:
        self.clock = clock
        self.speed_kmh = 0.0
        self.distance_m = 0.0
        self.elapsed_s = 0.0
        self._device_distance = False
        self._device_elapsed = False
        self._last_t: float | None = None

    def update(self, data: TreadmillData) -> Sample:
        now = self.clock.now()
        dt = 0.0 if self._last_t is None else max(0.0, now - self._last_t)
        self._last_t = now
        was_moving = self.speed_kmh > 0

        if data.speed_kmh is not None:
            if not was_moving and data.speed_kmh > 0:
                if not self._device_distance:
                    self.distance_m = 0.0
                if not self._device_elapsed:
                    self.elapsed_s = 0.0
            if was_moving:
                avg = (self.speed_kmh + data.speed_kmh) / 2
                if not self._device_distance:
                    self.distance_m += avg / 3.6 * dt
                if not self._device_elapsed:
                    self.elapsed_s += dt
            self.speed_kmh = data.speed_kmh
        if data.distance_m is not None:
            self._device_distance = True
            self.distance_m = float(data.distance_m)
        if data.elapsed_s is not None:
            self._device_elapsed = True
            self.elapsed_s = float(data.elapsed_s)
        return self.sample()

    def sample(self) -> Sample:
        return Sample(
            speed_kmh=round(self.speed_kmh, 2),
            distance_m=round(self.distance_m, 1),
            steps=None,
            elapsed_s=round(self.elapsed_s, 1),
            belt=BeltState.RUNNING if self.speed_kmh > 0 else BeltState.STOPPED,
        )


class FtmsProtocol(ProtocolHandler):
    protocol = Protocol.FTMS

    def __init__(self, clock: Clock | None = None) -> None:
        self.clock: Clock = clock or MonotonicClock()
        self.speed_range = DEFAULT_SPEED_RANGE
        self._session = FtmsSession(self.clock)
        self._publish: Callable[[Sample], None] | None = None

    async def start(self, client: GattClient, publish: Callable[[Sample], None]) -> None:
        self._publish = publish
        try:
            self.speed_range = parse_speed_range(
                bytes(await client.read_gatt_char(FTMS_SPEED_RANGE_CHAR))
            )
        except Exception as exc:  # optional characteristic; fall back to the default
            log.info("no usable FTMS speed range (%s); assuming %s", exc, DEFAULT_SPEED_RANGE)
        await client.start_notify(FTMS_TREADMILL_DATA_CHAR, self._on_notify)

    async def stop(self) -> None:
        self._publish = None

    def _on_notify(self, _char: object, data: bytearray) -> None:
        raw = bytes(data)
        log.debug("FTMS rx %s", raw.hex(" "))
        try:
            parsed = parse_treadmill_data(raw)
        except ValueError as exc:
            log.warning("dropping FTMS frame: %s", exc)
            return
        sample = self._session.update(parsed)
        if self._publish is not None:
            self._publish(sample)
