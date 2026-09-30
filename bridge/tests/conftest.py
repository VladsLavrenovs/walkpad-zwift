from __future__ import annotations

import asyncio
from collections.abc import Callable

import pytest

from walkpad_bridge.fake import FakeBackend
from walkpad_bridge.safety import SafetyConfig, SpeedController


class VirtualClock:
    """Time only moves when someone sleeps. Makes ramps instant and deterministic."""

    def __init__(self) -> None:
        self.t = 0.0

    def now(self) -> float:
        return self.t

    async def sleep(self, seconds: float) -> None:
        self.t += seconds
        await asyncio.sleep(0)


async def run_until(condition: Callable[[], bool], max_yields: int = 10_000) -> None:
    """Let other tasks run until `condition()` holds."""
    for _ in range(max_yields):
        if condition():
            return
        await asyncio.sleep(0)
    raise AssertionError("condition never became true")


def speed_commands(fake: FakeBackend) -> list[tuple[float, float]]:
    return [(c.t, c.kmh) for c in fake.commands if c.name == "set_speed" and c.kmh is not None]


@pytest.fixture
def clock() -> VirtualClock:
    return VirtualClock()


@pytest.fixture
def make_fake(clock: VirtualClock) -> Callable[..., FakeBackend]:
    def make(**kwargs: object) -> FakeBackend:
        kwargs.setdefault("clock", clock)
        kwargs.setdefault("autotick", False)
        kwargs.setdefault("seed", 1)
        return FakeBackend(**kwargs)  # type: ignore[arg-type]

    return make


@pytest.fixture
async def walking_fake(make_fake: Callable[..., FakeBackend]) -> FakeBackend:
    """Connected fake, belt already running at 3.0 km/h."""
    fake = make_fake(initial_speed_kmh=3.0)
    await fake.connect()
    return fake


@pytest.fixture
def controller(walking_fake: FakeBackend, clock: VirtualClock) -> SpeedController:
    return SpeedController(walking_fake, SafetyConfig(), clock)
