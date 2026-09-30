"""Every safety rule from CLAUDE.md, against the FAKE backend on virtual time."""

from __future__ import annotations

import asyncio
import logging
import math
import re
from collections.abc import Callable
from pathlib import Path

import pytest

from conftest import VirtualClock, run_until, speed_commands
from walkpad_bridge.backend import BeltState, Sample
from walkpad_bridge.fake import FakeBackend
from walkpad_bridge.safety import (
    BeltNotRunningError,
    ConnectionLostError,
    SafetyConfig,
    SafetyEvent,
    SafetyEventKind,
    SpeedController,
)

MakeFake = Callable[..., FakeBackend]


def assert_ramp_respected(
    fake: FakeBackend, start: tuple[float, float], max_rate: float
) -> None:
    """Every speed command changes speed by at most max_rate * elapsed time since the previous."""
    points = [start, *speed_commands(fake)]
    for (t0, v0), (t1, v1) in zip(points, points[1:]):
        assert t1 > t0, f"two speed commands at the same instant: {points}"
        assert abs(v1 - v0) <= max_rate * (t1 - t0) + 1e-9, f"ramp violated: {v0} -> {v1}"


# --- speed cap and device range ---------------------------------------------------------------


async def test_default_cap_is_6_kmh(controller: SpeedController, walking_fake: FakeBackend) -> None:
    assert await controller.set_speed(10.0) == 6.0
    await controller.wait_until_reached()
    assert max(v for _, v in speed_commands(walking_fake)) == 6.0


async def test_configured_cap_below_device_max(
    walking_fake: FakeBackend, clock: VirtualClock
) -> None:
    controller = SpeedController(walking_fake, SafetyConfig(max_speed_kmh=4.0), clock)
    assert await controller.set_speed(5.5) == 4.0
    await controller.wait_until_reached()
    assert max(v for _, v in speed_commands(walking_fake)) == 4.0


async def test_device_max_wins_over_higher_cap(
    walking_fake: FakeBackend, clock: VirtualClock
) -> None:
    controller = SpeedController(walking_fake, SafetyConfig(max_speed_kmh=12.0), clock)
    assert controller.max_speed_kmh == walking_fake.speed_range.max_kmh
    assert await controller.set_speed(12.0) == 6.0


async def test_below_device_min_is_raised_to_min(controller: SpeedController) -> None:
    assert await controller.set_speed(0.2) == 0.5


async def test_speed_is_quantized_to_device_resolution(controller: SpeedController) -> None:
    assert await controller.set_speed(3.14) == 3.1


@pytest.mark.parametrize("bad", [-1.0, math.nan, math.inf])
async def test_invalid_speed_rejected(
    controller: SpeedController, walking_fake: FakeBackend, bad: float
) -> None:
    with pytest.raises(ValueError):
        await controller.set_speed(bad)
    assert speed_commands(walking_fake) == []


async def test_cap_below_device_min_is_a_config_error(
    walking_fake: FakeBackend, clock: VirtualClock
) -> None:
    with pytest.raises(ValueError):
        SpeedController(walking_fake, SafetyConfig(max_speed_kmh=0.3), clock)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"max_speed_kmh": 0},
        {"max_speed_kmh": -1},
        {"max_speed_kmh": math.nan},
        {"max_ramp_kmh_per_s": 0},
        {"ramp_tick_s": 0},
        {"reconnect_attempts": 0},
    ],
)
def test_invalid_safety_config_rejected(kwargs: dict[str, float]) -> None:
    with pytest.raises(ValueError):
        SafetyConfig(**kwargs)


async def test_ramp_step_smaller_than_resolution_is_a_config_error(
    walking_fake: FakeBackend, clock: VirtualClock
) -> None:
    with pytest.raises(ValueError):
        SpeedController(
            walking_fake, SafetyConfig(max_ramp_kmh_per_s=0.5, ramp_tick_s=0.1), clock
        )


# --- ramp rate --------------------------------------------------------------------------------


async def test_ramp_up_respects_default_rate(
    controller: SpeedController, walking_fake: FakeBackend
) -> None:
    await controller.set_speed(6.0)
    await controller.wait_until_reached()
    assert [v for _, v in speed_commands(walking_fake)] == [3.5, 4.0, 4.5, 5.0, 5.5, 6.0]
    assert_ramp_respected(walking_fake, (0.0, 3.0), 0.5)


async def test_ramp_down_respects_rate(
    controller: SpeedController, walking_fake: FakeBackend
) -> None:
    await controller.set_speed(1.0)
    await controller.wait_until_reached()
    assert [v for _, v in speed_commands(walking_fake)] == [2.5, 2.0, 1.5, 1.0]
    assert_ramp_respected(walking_fake, (0.0, 3.0), 0.5)


async def test_retargeting_mid_ramp_respects_rate(
    controller: SpeedController, walking_fake: FakeBackend
) -> None:
    await controller.set_speed(6.0)
    await run_until(lambda: len(speed_commands(walking_fake)) >= 2)
    await controller.set_speed(1.0)
    await controller.wait_until_reached()
    await controller.set_speed(4.0)  # new ramp right after the last one finished
    await controller.wait_until_reached()
    assert speed_commands(walking_fake)[-1][1] == 4.0
    assert_ramp_respected(walking_fake, (0.0, 3.0), 0.5)


async def test_configured_ramp_rate(walking_fake: FakeBackend, clock: VirtualClock) -> None:
    cfg = SafetyConfig(max_ramp_kmh_per_s=0.2, ramp_tick_s=1.0)
    controller = SpeedController(walking_fake, cfg, clock)
    await controller.set_speed(4.0)
    await controller.wait_until_reached()
    assert len(speed_commands(walking_fake)) == 5
    assert_ramp_respected(walking_fake, (0.0, 3.0), 0.2)


async def test_ramp_after_start_pins_one_step_from_actual_then_ramps(
    make_fake: MakeFake, clock: VirtualClock
) -> None:
    fake = make_fake()
    await fake.connect()
    controller = SpeedController(fake, SafetyConfig(), clock)
    await controller.start()
    await controller.set_speed(2.0)
    await controller.wait_until_reached()
    # The pin is sent at once (stopping a pad's own run-up): one step from the belt's speed
    # (device min 0.5 here) towards the target.
    commands = speed_commands(fake)
    assert [v for _, v in commands] == [1.0, 1.5, 2.0]
    assert commands[0][0] == 0.0
    for (t0, v0), (t1, v1) in zip(commands, commands[1:]):
        assert t1 > t0 and abs(v1 - v0) <= 0.5 * (t1 - t0) + 1e-9


async def test_ramp_from_belt_above_cap_commands_the_cap_first(
    make_fake: MakeFake, clock: VirtualClock
) -> None:
    fake = make_fake(initial_speed_kmh=5.0)  # e.g. set by the pad's own remote
    await fake.connect()
    controller = SpeedController(fake, SafetyConfig(max_speed_kmh=4.0), clock)
    await controller.set_speed(3.0)
    await controller.wait_until_reached()
    # Never a command above the cap: straight to 4.0 (at once), then the normal ramp.
    assert speed_commands(fake) == [(0.0, 4.0), (1.0, 3.5), (2.0, 3.0)]


async def test_set_speed_requires_running_belt(make_fake: MakeFake, clock: VirtualClock) -> None:
    fake = make_fake()
    await fake.connect()
    controller = SpeedController(fake, SafetyConfig(), clock)
    with pytest.raises(BeltNotRunningError):
        await controller.set_speed(3.0)
    assert speed_commands(fake) == []


# --- stop -------------------------------------------------------------------------------------


async def test_stop_is_immediate_and_cancels_ramp(
    controller: SpeedController, walking_fake: FakeBackend
) -> None:
    await controller.set_speed(6.0)
    await run_until(lambda: len(speed_commands(walking_fake)) >= 1)
    await controller.stop()
    n = len(speed_commands(walking_fake))
    assert walking_fake.commands[-1].name == "stop"
    assert walking_fake.belt_state is BeltState.STOPPING
    for _ in range(100):  # give a (wrongly) surviving ramp task every chance to run
        await asyncio.sleep(0)
    assert len(speed_commands(walking_fake)) == n
    assert controller.target_kmh is None


async def test_set_speed_zero_means_stop(
    controller: SpeedController, walking_fake: FakeBackend
) -> None:
    assert await controller.set_speed(0) == 0.0
    assert walking_fake.commands[-1].name == "stop"


async def test_close_stops_running_belt_and_disconnects(
    controller: SpeedController, walking_fake: FakeBackend
) -> None:
    await controller.close()
    assert [c.name for c in walking_fake.commands] == ["stop"]
    assert not walking_fake.is_connected


# --- stop on pad connection loss --------------------------------------------------------------


async def test_connection_loss_while_running_reconnects_and_stops(
    controller: SpeedController, walking_fake: FakeBackend
) -> None:
    walking_fake.simulate_connection_loss()
    assert controller.recovery_task is not None
    assert await controller.recovery_task is True
    assert walking_fake.is_connected
    assert walking_fake.commands[-1].name == "stop"
    walking_fake.advance(5)
    assert walking_fake.belt_state is BeltState.STOPPED


async def test_connection_loss_mid_ramp_cancels_ramp(
    controller: SpeedController, walking_fake: FakeBackend
) -> None:
    await controller.set_speed(6.0)
    await run_until(lambda: len(speed_commands(walking_fake)) >= 1)
    walking_fake.simulate_connection_loss()
    assert controller.recovery_task is not None
    await controller.recovery_task
    for _ in range(100):  # give a (wrongly) surviving ramp task every chance to run
        await asyncio.sleep(0)
    names = [c.name for c in walking_fake.commands]
    assert names[-1] == "stop"
    assert names.count("set_speed") == 1


async def test_commands_refused_until_recovered(
    controller: SpeedController, walking_fake: FakeBackend
) -> None:
    walking_fake.fail_connects = 1
    walking_fake.simulate_connection_loss()
    with pytest.raises(ConnectionLostError):
        await controller.set_speed(4.0)
    with pytest.raises(ConnectionLostError):
        await controller.start()
    assert controller.recovery_task is not None
    assert await controller.recovery_task is True
    await controller.start()  # usable again


async def test_reconnect_retries_then_stops(
    controller: SpeedController, walking_fake: FakeBackend
) -> None:
    before = walking_fake.connect_attempts
    walking_fake.fail_connects = 2
    walking_fake.simulate_connection_loss()
    assert controller.recovery_task is not None
    assert await controller.recovery_task is True
    assert walking_fake.connect_attempts - before == 3
    assert walking_fake.commands[-1].name == "stop"


async def test_reconnect_gives_up_loudly(
    controller: SpeedController, walking_fake: FakeBackend, caplog: pytest.LogCaptureFixture
) -> None:
    walking_fake.fail_connects = 100
    walking_fake.simulate_connection_loss()
    assert controller.recovery_task is not None
    assert await controller.recovery_task is False
    assert any(r.levelno == logging.CRITICAL for r in caplog.records)
    with pytest.raises(ConnectionLostError):
        await controller.set_speed(3.0)


# --- stop on controlling-client disconnect ----------------------------------------------------


async def test_controlling_client_disconnect_stops_belt(
    controller: SpeedController, walking_fake: FakeBackend
) -> None:
    await controller.set_speed(4.0, client="phone")
    await controller.client_disconnected("laptop")
    assert "stop" not in [c.name for c in walking_fake.commands]

    await controller.client_disconnected("phone")
    assert walking_fake.commands[-1].name == "stop"
    assert controller.controlling_client is None


async def test_latest_commanding_client_is_in_control(
    controller: SpeedController, walking_fake: FakeBackend
) -> None:
    await controller.set_speed(4.0, client="phone")
    await controller.set_speed(4.5, client="laptop")
    await controller.client_disconnected("phone")
    assert "stop" not in [c.name for c in walking_fake.commands]
    await controller.client_disconnected("laptop")
    assert walking_fake.commands[-1].name == "stop"


async def test_client_disconnect_with_stopped_belt_sends_nothing(
    make_fake: MakeFake, clock: VirtualClock
) -> None:
    fake = make_fake()
    await fake.connect()
    controller = SpeedController(fake, SafetyConfig(), clock)
    await controller.start(client="phone")
    await controller.stop(client="phone")
    fake.advance(5)
    n = len(fake.commands)
    await controller.client_disconnected("phone")
    assert len(fake.commands) == n


# --- single path for speed changes ------------------------------------------------------------


@pytest.mark.parametrize(
    ("pattern", "allowed"),
    [
        # Belt commands on a backend: only SpeedController.
        (r"backend\.(set_speed|start|stop)\(", "safety.py"),
        # Belt commands on a BLE protocol handler: only BleBackend (itself called by the above).
        (r"\.(set_belt_speed|start_belt|stop_belt)\(", "blebackend.py"),
    ],
)
def test_only_speed_controller_commands_the_belt(pattern: str, allowed: str) -> None:
    """Tripwire: belt commands reach the pad only through SpeedController."""
    src = Path(__file__).resolve().parents[1] / "src" / "walkpad_bridge"
    offenders = [
        p.name for p in src.glob("*.py") if p.name != allowed and re.search(pattern, p.read_text())
    ]
    assert offenders == []


# --- belt above cap: not forced down, but reported --------------------------------------------


def _sample(kmh: float) -> Sample:
    return Sample(speed_kmh=kmh, distance_m=0, steps=0, elapsed_s=0, belt=BeltState.RUNNING)


async def test_belt_above_cap_emits_event_once_and_sends_nothing(
    walking_fake: FakeBackend, clock: VirtualClock, caplog: pytest.LogCaptureFixture
) -> None:
    controller = SpeedController(walking_fake, SafetyConfig(max_speed_kmh=4.0), clock)
    events: list[SafetyEvent] = []
    controller.add_event_listener(events.append)

    for kmh in (3.9, 4.0, 5.0, 5.2, 5.1):
        controller.observe(_sample(kmh))
    assert [e.kind for e in events] == [SafetyEventKind.BELT_ABOVE_CAP]
    assert (events[0].speed_kmh, events[0].cap_kmh) == (5.0, 4.0)
    assert controller.belt_above_cap
    assert any(r.levelno == logging.WARNING and "above" in r.message for r in caplog.records)
    assert walking_fake.commands == []  # behaviour unchanged: no forced slow-down

    controller.observe(_sample(4.0))
    controller.observe(_sample(3.5))
    assert [e.kind for e in events] == [
        SafetyEventKind.BELT_ABOVE_CAP,
        SafetyEventKind.BELT_WITHIN_CAP,
    ]
    assert not controller.belt_above_cap


async def test_above_cap_detected_when_ramp_starts(
    make_fake: MakeFake, clock: VirtualClock
) -> None:
    fake = make_fake(initial_speed_kmh=5.0)
    await fake.connect()
    controller = SpeedController(fake, SafetyConfig(max_speed_kmh=4.0), clock)
    events: list[SafetyEvent] = []
    controller.add_event_listener(events.append)
    await controller.set_speed(4.0)
    await controller.wait_until_reached()
    assert events[0].kind is SafetyEventKind.BELT_ABOVE_CAP


async def test_failing_event_listener_does_not_break_safety(
    walking_fake: FakeBackend, clock: VirtualClock
) -> None:
    controller = SpeedController(walking_fake, SafetyConfig(max_speed_kmh=4.0), clock)

    def broken(_: SafetyEvent) -> None:
        raise RuntimeError("ui down")

    received: list[SafetyEvent] = []
    controller.add_event_listener(broken)
    controller.add_event_listener(received.append)
    controller.observe(_sample(5.0))
    assert len(received) == 1


# --- command listeners (lag metering) -------------------------------------------------------


async def test_command_listener_sees_every_command(
    make_fake: MakeFake, clock: VirtualClock
) -> None:
    fake = make_fake()
    await fake.connect()
    controller = SpeedController(fake, SafetyConfig(), clock)
    seen: list[tuple[str, float | None]] = []
    controller.add_command_listener(lambda name, kmh: seen.append((name, kmh)))
    await controller.start()
    await controller.set_speed(1.5)
    await controller.wait_until_reached()
    await controller.stop()
    assert seen == [
        ("start", None), ("set_speed", 1.0), ("set_speed", 1.5), ("stop", None)
    ]


async def test_close_reports_its_stop(controller: SpeedController) -> None:
    seen: list[str] = []
    controller.add_command_listener(lambda name, _kmh: seen.append(name))
    await controller.close()
    assert seen == ["stop"]


# --- a stop owed after a lost link is delivered on any later reconnect (hardware check 6) ------


async def test_stop_stays_owed_when_recovery_gives_up(
    walking_fake: FakeBackend, clock: VirtualClock
) -> None:
    controller = SpeedController(walking_fake, SafetyConfig(), clock)
    await controller.set_speed(3.0, client="page")
    walking_fake.fail_connects = 3  # the Bluetooth adapter is off for all three attempts
    walking_fake.simulate_connection_loss()
    assert await controller.recovery_task is False  # type: ignore[misc]
    assert controller.stop_owed
    assert walking_fake.belt_state is BeltState.RUNNING  # the pad keeps going on its own

    await walking_fake.connect()  # someone else (the service loop) reconnects later
    await controller.reconnected()
    assert walking_fake.commands[-1].name == "stop"
    assert not controller.stop_owed and controller.controlling_client is None
    await controller.set_speed(0)  # usable again


async def test_reconnected_is_a_no_op_without_an_owed_stop(
    controller: SpeedController, walking_fake: FakeBackend
) -> None:
    await controller.reconnected()
    assert walking_fake.commands == []
