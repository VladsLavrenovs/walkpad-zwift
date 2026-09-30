"""FAKE backend: a simulated WalkingPad for development and tests. No Bluetooth involved."""

from __future__ import annotations

import asyncio
import random
from collections.abc import AsyncIterator
from typing import NamedTuple

from .backend import (
    BackendError,
    BeltState,
    NotConnectedError,
    PadBackend,
    Sample,
    SpeedRange,
)
from .clock import Clock, MonotonicClock

DEFAULT_SPEED_RANGE = SpeedRange(min_kmh=0.5, max_kmh=6.0, resolution_kmh=0.1)


class Command(NamedTuple):
    """A command the fake received, for tests to inspect."""

    t: float
    name: str
    kmh: float | None = None


def step_length_m(speed_kmh: float) -> float:
    """Rough walking step length: ~0.6 m at 3 km/h, ~0.7 m at 5 km/h."""
    return 0.45 + 0.05 * speed_kmh


class FakeBackend(PadBackend):
    """Simulated pad.

    The belt accelerates towards its setpoint at `accel_kmh_per_s` (like the real pad does on
    its own), distance integrates belt speed, and step cadence follows speed with a little
    jitter. Set `autotick=False` to drive the simulation manually with `advance()`.
    """

    def __init__(
        self,
        *,
        speed_range: SpeedRange = DEFAULT_SPEED_RANGE,
        initial_speed_kmh: float = 0.0,
        sample_interval_s: float = 1.0,
        accel_kmh_per_s: float = 1.0,
        clock: Clock | None = None,
        autotick: bool = True,
        seed: int | None = None,
        fail_connects: int = 0,
    ) -> None:
        super().__init__()
        if initial_speed_kmh and not (
            speed_range.min_kmh <= initial_speed_kmh <= speed_range.max_kmh
        ):
            raise ValueError(f"initial speed {initial_speed_kmh} outside device range")
        self.speed_range = speed_range
        self.sample_interval_s = sample_interval_s
        self.accel_kmh_per_s = accel_kmh_per_s
        self.clock: Clock = clock or MonotonicClock()
        self.autotick = autotick
        self.fail_connects = fail_connects
        self.connect_attempts = 0
        self.commands: list[Command] = []

        self._rng = random.Random(seed)
        self._connected = False
        self._setpoint = initial_speed_kmh
        self._speed = initial_speed_kmh
        self._state = BeltState.RUNNING if initial_speed_kmh else BeltState.STOPPED
        self._distance_m = 0.0
        self._steps = 0.0
        self._elapsed_s = 0.0
        self._subscribers: set[asyncio.Queue[Sample | None]] = set()
        self._ticker: asyncio.Task[None] | None = None

    # --- PadBackend -------------------------------------------------------------------------

    @property
    def is_connected(self) -> bool:
        return self._connected

    @property
    def belt_state(self) -> BeltState:
        return self._state

    @property
    def speed_kmh(self) -> float:
        return self._speed

    async def connect(self) -> None:
        self.connect_attempts += 1
        if self.fail_connects > 0:
            self.fail_connects -= 1
            raise BackendError("simulated connect failure")
        self._connected = True
        if self.autotick and self._ticker is None:
            self._ticker = asyncio.create_task(self._tick_forever())

    async def disconnect(self) -> None:
        self._go_offline()

    async def samples(self) -> AsyncIterator[Sample]:
        self._require_connected()
        queue: asyncio.Queue[Sample | None] = asyncio.Queue(maxsize=256)
        self._subscribers.add(queue)
        try:
            yield self.sample()
            while (item := await queue.get()) is not None:
                yield item
        finally:
            self._subscribers.discard(queue)

    async def set_speed(self, kmh: float) -> None:
        self._record("set_speed", kmh)
        rng = self.speed_range
        if not (rng.min_kmh <= kmh <= rng.max_kmh):
            raise ValueError(f"{kmh} km/h outside device range {rng.min_kmh}-{rng.max_kmh}")
        if self._state is not BeltState.RUNNING:
            raise BackendError("belt is not running")
        self._setpoint = round(round(kmh / rng.resolution_kmh) * rng.resolution_kmh, 6)

    async def start(self) -> None:
        self._record("start")
        if self._state is BeltState.STOPPED:
            self._distance_m = self._steps = self._elapsed_s = 0.0
        self._state = BeltState.RUNNING
        self._setpoint = self.speed_range.min_kmh

    async def stop(self) -> None:
        self._record("stop")
        if self._state is not BeltState.STOPPED:
            self._state = BeltState.STOPPING
            self._setpoint = 0.0

    # --- simulation -------------------------------------------------------------------------

    def advance(self, dt: float) -> None:
        """Advance the simulated pad by `dt` seconds."""
        if self._state is BeltState.STOPPED:
            return
        old = self._speed
        max_delta = self.accel_kmh_per_s * dt
        self._speed += max(-max_delta, min(max_delta, self._setpoint - self._speed))
        if self._state is BeltState.STOPPING and self._speed <= 1e-9:
            self._speed = 0.0
            self._state = BeltState.STOPPED

        avg_kmh = (old + self._speed) / 2
        if avg_kmh <= 0:
            return
        self._distance_m += avg_kmh / 3.6 * dt
        self._elapsed_s += dt
        cadence_per_s = (avg_kmh / 3.6) / step_length_m(avg_kmh)
        self._steps += cadence_per_s * dt * (1 + self._rng.gauss(0, 0.02))

    def sample(self) -> Sample:
        return Sample(
            speed_kmh=round(self._speed, 1),
            distance_m=round(self._distance_m, 1),
            steps=int(self._steps),
            elapsed_s=round(self._elapsed_s, 1),
            belt=self._state,
        )

    def simulate_connection_loss(self) -> None:
        """Drop the link like a BLE timeout would. The belt itself keeps doing what it was doing."""
        if not self._connected:
            return
        self._go_offline()
        self._notify_connection_lost()

    # --- internals --------------------------------------------------------------------------

    def _record(self, name: str, kmh: float | None = None) -> None:
        self._require_connected()
        self.commands.append(Command(self.clock.now(), name, kmh))

    def _require_connected(self) -> None:
        if not self._connected:
            raise NotConnectedError("fake pad is not connected")

    async def _tick_forever(self) -> None:
        while True:
            await self.clock.sleep(self.sample_interval_s)
            self.advance(self.sample_interval_s)
            self._publish(self.sample())

    def _publish(self, item: Sample | None) -> None:
        for queue in list(self._subscribers):
            if queue.full():
                queue.get_nowait()  # drop the oldest; live data should never block the sim
            queue.put_nowait(item)

    def _go_offline(self) -> None:
        self._connected = False
        if self._ticker is not None:
            self._ticker.cancel()
            self._ticker = None
        self._publish(None)
