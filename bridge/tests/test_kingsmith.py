import pytest

from walkpad_bridge.backend import BeltState
from walkpad_bridge.kingsmith import STATUS_QUERY, build_frame, parse_status


def status_frame(belt_state: int = 1, speed: int = 30, mode: int = 1) -> bytes:
    """F8 A2 status frame: 600 s, 100 (x10 m), 1500 steps."""
    payload = bytes([0xA2, belt_state, speed, mode, 0x00, 0x02, 0x58, 0x00, 0x00, 0x64,
                     0x00, 0x05, 0xDC, 0x5A, 0x00, 0x00, 0x00])
    return bytes([0xF8, *payload, sum(payload) % 256, 0xFD])


def test_status_query_matches_ph4_walkingpad() -> None:
    assert STATUS_QUERY == bytes([0xF7, 0xA2, 0x00, 0x00, 0xA2, 0xFD])
    assert build_frame(bytes([0xA2, 0x01, 0x1E])) == bytes([0xF7, 0xA2, 0x01, 0x1E, 0xC1, 0xFD])


def test_parse_status() -> None:
    status = parse_status(status_frame())
    assert status is not None
    assert status.speed_kmh == 3.0
    assert status.elapsed_s == 600
    assert status.distance_m == 1000
    assert status.steps == 1500
    assert status.mode == 1
    sample = status.to_sample()
    assert (sample.speed_kmh, sample.distance_m, sample.steps, sample.elapsed_s) == (
        3.0, 1000.0, 1500, 600.0
    )
    assert sample.belt is BeltState.RUNNING


@pytest.mark.parametrize(
    ("belt_state", "speed", "expected"),
    [
        (1, 30, BeltState.RUNNING),
        (9, 0, BeltState.RUNNING),  # start countdown
        (0, 20, BeltState.STOPPING),
        (0, 0, BeltState.STOPPED),
        (5, 0, BeltState.STOPPED),  # standby
        (8, 0, BeltState.RUNNING),  # countdown, seen on the owner's pad
        (7, 0, BeltState.RUNNING),
        (42, 10, BeltState.RUNNING),  # unknown state but moving
        (42, 0, BeltState.STOPPING),  # unknown state: never report stopped
    ],
)
def test_belt_state_mapping(belt_state: int, speed: int, expected: BeltState) -> None:
    status = parse_status(status_frame(belt_state, speed))
    assert status is not None and status.belt is expected


def test_other_message_types_are_ignored() -> None:
    assert parse_status(bytes([0xF8, 0xA7, 0xAA, 0xFF, 0x50, 0xFD])) is None
    assert parse_status(b"") is None


def test_truncated_status_is_rejected() -> None:
    with pytest.raises(ValueError, match="too short"):
        parse_status(status_frame()[:10])


@pytest.mark.parametrize("bad", [
    status_frame()[:-2] + b"\x00\xfd",  # wrong checksum
    status_frame()[:-1] + b"\x00",  # wrong trailer
    status_frame()[:-3],  # cut off, but still long enough to parse
])
def test_corrupt_status_is_rejected(bad: bytes) -> None:
    with pytest.raises(ValueError, match="checksum"):
        parse_status(bad)


# Captured from the real pad (firmware M30_V187.2.0, BLE module WLT8266M).
REAL_STANDBY = bytes.fromhex("f8 a2 05 00 02 00 00 00 00 00 00 00 00 00 00 00 00 00 a9 fd")
REAL_RUNNING = bytes.fromhex("f8 a2 01 19 01 00 00 03 00 00 00 00 00 00 01 00 00 00 c1 fd")
REAL_WALKING = bytes.fromhex("f8 a2 01 19 01 00 00 40 00 00 04 00 00 47 01 00 00 00 49 fd")


def test_real_frames() -> None:
    standby = parse_status(REAL_STANDBY)
    assert standby is not None
    assert (standby.belt_state, standby.mode, standby.belt) == (5, 2, BeltState.STOPPED)
    running = parse_status(REAL_RUNNING)
    assert running is not None
    assert (running.belt_state, running.mode, running.belt) == (1, 1, BeltState.RUNNING)
    assert (running.speed_kmh, running.elapsed_s, running.distance_m, running.steps) == (2.5, 3, 0, 0)
    walking = parse_status(REAL_WALKING)  # pad display: 01:04, 0.04 km
    assert walking is not None
    assert (walking.speed_kmh, walking.elapsed_s, walking.distance_m, walking.steps) == (2.5, 64, 40, 71)
