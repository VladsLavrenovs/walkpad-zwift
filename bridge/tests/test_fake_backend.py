from __future__ import annotations

import asyncio
from collections.abc import Callable

import pytest

from walkpad_bridge.backend import BackendError, BeltState, NotConnectedError
from walkpad_bridge.clock import ScaledClock
from walkpad_bridge.fake import FakeBackend

MakeFake = Callable[..., FakeBackend]


def run_for(fake: FakeBackend, seconds: float, dt: float = 0.5) -> None:
    for _ in range(round(seconds / dt)):
        fake.advance(dt)


async def test_commands_require_connection(make_fake: MakeFake) -> None:
    fake = make_fake()
    for command in (fake.start(), fake.stop(), fake.set_speed(3.0)):
        with pytest.raises(NotConnectedError):
            await command
    assert fake.commands == []


async def test_start_runs_belt_at_device_min_and_resets_counters(make_fake: MakeFake) -> None:
    fake = make_fake()
    await fake.connect()
    assert fake.belt_state is BeltState.STOPPED

    await fake.start()
    run_for(fake, 5)
    s = fake.sample()
    assert s.belt is BeltState.RUNNING
    assert s.speed_kmh == fake.speed_range.min_kmh

    await fake.stop()
    run_for(fake, 5)
    assert fake.sample().distance_m > 0
    await fake.start()
    s = fake.sample()
    assert (s.distance_m, s.steps, s.elapsed_s) == (0, 0, 0)


async def test_belt_accelerates_gradually(walking_fake: FakeBackend) -> None:
    await walking_fake.set_speed(5.0)
    walking_fake.advance(1.0)
    assert walking_fake.sample().speed_kmh == pytest.approx(4.0)
    walking_fake.advance(1.0)
    walking_fake.advance(1.0)
    assert walking_fake.sample().speed_kmh == pytest.approx(5.0)


async def test_set_speed_outside_device_range_rejected(walking_fake: FakeBackend) -> None:
    for kmh in (0.1, 6.5, -1.0):
        with pytest.raises(ValueError):
            await walking_fake.set_speed(kmh)


async def test_set_speed_when_stopped_rejected(make_fake: MakeFake) -> None:
    fake = make_fake()
    await fake.connect()
    with pytest.raises(BackendError):
        await fake.set_speed(3.0)


async def test_distance_integrates_speed(make_fake: MakeFake) -> None:
    fake = make_fake(initial_speed_kmh=3.6)  # exactly 1 m/s
    await fake.connect()
    run_for(fake, 100)
    s = fake.sample()
    assert s.distance_m == pytest.approx(100.0)
    assert s.elapsed_s == pytest.approx(100.0)


async def test_steps_follow_speed(make_fake: MakeFake) -> None:
    cadences = []
    for kmh in (3.0, 5.0):
        fake = make_fake(initial_speed_kmh=kmh)
        await fake.connect()
        run_for(fake, 60)
        cadences.append(fake.sample().steps)  # steps per minute
    slow, fast = cadences
    assert 80 <= slow <= 110
    assert 100 <= fast <= 130
    assert fast > slow


async def test_stop_decelerates_then_stops_and_keeps_totals(walking_fake: FakeBackend) -> None:
    run_for(walking_fake, 10)
    await walking_fake.stop()
    walking_fake.advance(1.0)
    assert walking_fake.belt_state is BeltState.STOPPING
    assert walking_fake.sample().speed_kmh == pytest.approx(2.0)

    run_for(walking_fake, 5)
    s = walking_fake.sample()
    assert s.belt is BeltState.STOPPED
    assert s.speed_kmh == 0
    assert s.distance_m > 0

    run_for(walking_fake, 10)
    assert walking_fake.sample() == s  # nothing moves while stopped


async def test_same_seed_is_deterministic(make_fake: MakeFake) -> None:
    runs = []
    for _ in range(2):
        fake = make_fake(initial_speed_kmh=4.0, seed=42)
        run_for(fake, 30)
        runs.append(fake.sample())
    assert runs[0] == runs[1]


async def test_sample_stream_ticks_on_its_own() -> None:
    fake = FakeBackend(initial_speed_kmh=4.0, clock=ScaledClock(100), seed=1)
    await fake.connect()
    samples = []
    async for s in fake.samples():
        samples.append(s)
        if len(samples) == 4:
            break
    await fake.disconnect()
    distances = [s.distance_m for s in samples]
    assert distances == sorted(distances)
    assert distances[-1] > distances[0]
    assert [s.elapsed_s for s in samples] == [0.0, 1.0, 2.0, 3.0]


async def test_sample_stream_ends_on_disconnect(walking_fake: FakeBackend) -> None:
    received = []

    async def consume() -> None:
        async for s in walking_fake.samples():
            received.append(s)

    task = asyncio.create_task(consume())
    await asyncio.sleep(0)
    await walking_fake.disconnect()
    await asyncio.wait_for(task, timeout=1)
    assert len(received) == 1  # the initial sample


async def test_connection_loss_notifies_and_belt_keeps_running(walking_fake: FakeBackend) -> None:
    calls = []
    walking_fake.add_connection_lost_listener(lambda: calls.append(True))
    walking_fake.simulate_connection_loss()
    assert calls == [True]
    assert not walking_fake.is_connected
    assert walking_fake.belt_state is BeltState.RUNNING  # a real pad would keep going too


async def test_deliberate_disconnect_does_not_notify(walking_fake: FakeBackend) -> None:
    calls = []
    walking_fake.add_connection_lost_listener(lambda: calls.append(True))
    await walking_fake.disconnect()
    assert calls == []


async def test_simulated_connect_failures(make_fake: MakeFake) -> None:
    fake = make_fake(fail_connects=2)
    for _ in range(2):
        with pytest.raises(BackendError):
            await fake.connect()
    await fake.connect()
    assert fake.is_connected
    assert fake.connect_attempts == 3
