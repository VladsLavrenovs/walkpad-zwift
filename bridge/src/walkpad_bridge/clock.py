"""Injectable time source, so ramps and simulations can run on virtual time in tests."""

from __future__ import annotations

import asyncio
import time
from typing import Protocol


class Clock(Protocol):
    def now(self) -> float: ...

    async def sleep(self, seconds: float) -> None: ...


class MonotonicClock:
    def now(self) -> float:
        return time.monotonic()

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds)


class ScaledClock:
    """Runs `scale` times faster than real time. For FAKE demos and CLI tests only."""

    def __init__(self, scale: float) -> None:
        if scale <= 0:
            raise ValueError("scale must be positive")
        self.scale = scale

    def now(self) -> float:
        return time.monotonic() * self.scale

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds / self.scale)
