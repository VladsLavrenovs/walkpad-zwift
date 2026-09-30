"""Pad backend interface shared by the FAKE backend and (later) the real BLE backends."""

from __future__ import annotations

import enum
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass


class BeltState(enum.StrEnum):
    STOPPED = "stopped"
    RUNNING = "running"
    STOPPING = "stopping"


@dataclass(frozen=True, slots=True)
class Sample:
    """One live reading from the pad. Counters are for the current session (reset on start)."""

    speed_kmh: float
    distance_m: float
    steps: int
    elapsed_s: float
    belt: BeltState


@dataclass(frozen=True, slots=True)
class SpeedRange:
    """Speeds the device accepts. `start()` begins the belt at `min_kmh`."""

    min_kmh: float
    max_kmh: float
    resolution_kmh: float = 0.1


class BackendError(Exception):
    """The pad refused a command or could not be reached."""


class NotConnectedError(BackendError):
    pass


class PadBackend(ABC):
    """Low-level pad access.

    Only `SpeedController` may call `set_speed`, `start` and `stop`; everything else goes
    through the controller so the safety rules always apply.
    """

    speed_range: SpeedRange

    def __init__(self) -> None:
        self._connection_lost_listeners: list[Callable[[], None]] = []

    @property
    @abstractmethod
    def is_connected(self) -> bool: ...

    @property
    @abstractmethod
    def belt_state(self) -> BeltState:
        """Last known belt state."""

    @property
    @abstractmethod
    def speed_kmh(self) -> float:
        """Last known actual belt speed."""

    @abstractmethod
    async def connect(self) -> None: ...

    @abstractmethod
    async def disconnect(self) -> None:
        """Deliberate disconnect. Does not fire connection-lost listeners."""

    @abstractmethod
    def samples(self) -> AsyncIterator[Sample]:
        """Live samples. Yields the current sample first; ends when the connection goes away."""

    @abstractmethod
    async def set_speed(self, kmh: float) -> None: ...

    @abstractmethod
    async def start(self) -> None: ...

    @abstractmethod
    async def stop(self) -> None: ...

    def add_connection_lost_listener(self, callback: Callable[[], None]) -> None:
        """`callback` runs (inside the event loop) when the connection drops unexpectedly."""
        self._connection_lost_listeners.append(callback)

    def _notify_connection_lost(self) -> None:
        for callback in list(self._connection_lost_listeners):
            callback()
