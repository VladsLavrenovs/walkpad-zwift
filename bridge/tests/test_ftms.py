import struct

import pytest

from conftest import VirtualClock
from walkpad_bridge.backend import BeltState
from walkpad_bridge.ftms import (
    ELAPSED_TIME,
    EXPENDED_ENERGY,
    HEART_RATE,
    INCLINATION,
    MORE_DATA,
    TOTAL_DISTANCE,
    FtmsSession,
    TreadmillData,
    parse_speed_range,
    parse_treadmill_data,
)


def speed_only(kmh: float) -> bytes:
    return struct.pack("<HH", 0, round(kmh * 100))


def test_speed_only() -> None:
    assert parse_treadmill_data(speed_only(3.25)) == TreadmillData(speed_kmh=3.25)


def test_fields_after_skipped_ones() -> None:
    flags = TOTAL_DISTANCE | INCLINATION | EXPENDED_ENERGY | HEART_RATE | ELAPSED_TIME
    data = (
        struct.pack("<HH", flags, 420)  # 4.20 km/h
        + (1234).to_bytes(3, "little")  # total distance, m
        + struct.pack("<hh", 5, 10)  # inclination, ramp angle
        + struct.pack("<HHB", 50, 300, 5)  # energy
        + bytes([95])  # heart rate
        + struct.pack("<H", 725)  # elapsed s
    )
    assert parse_treadmill_data(data) == TreadmillData(4.2, 1234, 725)


def test_more_data_flag_means_no_speed() -> None:
    data = struct.pack("<H", MORE_DATA | TOTAL_DISTANCE) + (77).to_bytes(3, "little")
    assert parse_treadmill_data(data) == TreadmillData(distance_m=77)


@pytest.mark.parametrize("data", [b"", b"\x00", speed_only(3)[:3], struct.pack("<HH", ELAPSED_TIME, 1)])
def test_truncated_data_is_rejected(data: bytes) -> None:
    with pytest.raises(ValueError):
        parse_treadmill_data(data)


def test_speed_range() -> None:
    r = parse_speed_range(bytes([50, 0, 0x58, 0x02, 10, 0]))
    assert (r.min_kmh, r.max_kmh, r.resolution_kmh) == (0.5, 6.0, 0.1)


@pytest.mark.parametrize("data", [b"\x01\x00", bytes([0, 0, 1, 0, 1, 0]), bytes([5, 0, 1, 0, 1, 0])])
def test_bad_speed_range(data: bytes) -> None:
    with pytest.raises(ValueError):
        parse_speed_range(data)


def test_session_integrates_when_device_sends_speed_only() -> None:
    clock = VirtualClock()
    session = FtmsSession(clock)
    assert session.update(TreadmillData(0.0)).belt is BeltState.STOPPED
    clock.t = 1
    session.update(TreadmillData(3.6))  # 1 m/s from now on
    for t in range(2, 12):
        clock.t = t
        sample = session.update(TreadmillData(3.6))
    assert sample.distance_m == pytest.approx(10.0)
    assert sample.elapsed_s == pytest.approx(10.0)
    assert sample.steps is None
    assert sample.belt is BeltState.RUNNING

    clock.t = 12
    assert session.update(TreadmillData(0.0)).belt is BeltState.STOPPED
    clock.t = 100
    session.update(TreadmillData(3.6))  # restart: counters reset, the pause is not counted
    clock.t = 101
    sample = session.update(TreadmillData(3.6))
    assert sample.distance_m == pytest.approx(1.0)
    assert sample.elapsed_s == pytest.approx(1.0)


def test_session_prefers_device_counters_and_merges_split_packets() -> None:
    clock = VirtualClock()
    session = FtmsSession(clock)
    session.update(TreadmillData(4.0))
    clock.t = 5
    sample = session.update(TreadmillData(distance_m=250, elapsed_s=200))  # "more data" packet
    assert (sample.speed_kmh, sample.distance_m, sample.elapsed_s) == (4.0, 250.0, 200.0)
    clock.t = 6
    sample = session.update(TreadmillData(4.0))
    assert (sample.distance_m, sample.elapsed_s) == (250.0, 200.0)  # no local integration now
