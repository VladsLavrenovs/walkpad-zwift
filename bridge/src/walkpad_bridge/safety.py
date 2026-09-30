"""SpeedController: the one and only path for belt speed changes.

Enforces the safety rules from CLAUDE.md:
- speed cap (config) and the device's valid range,
- max ramp rate (config): speed changes are sent in steps no larger than
  `max_ramp_kmh_per_s * ramp_tick_s`, one step per tick,
- stop the belt if the pad connection drops (reconnect, then stop) or if the controlling
  client disconnects.

It never forces a belt that is already above the cap (e.g. set with the pad's own remote) down
on its own; it emits a BELT_ABOVE_CAP safety event so the UI can show it, and the next
`set_speed` ramps it down gradually.
"""

from __future__ import annotations

import asyncio
import enum
import logging
import math
from collections.abc import Callable
from dataclasses import dataclass

from .backend import BackendError, BeltState, PadBackend, Sample
from .clock import Clock, MonotonicClock

log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class SafetyConfig:
    max_speed_kmh: float = 6.0
    max_ramp_kmh_per_s: float = 0.5
    ramp_tick_s: float = 1.0
    reconnect_attempts: int = 3
    reconnect_backoff_s: float = 1.0

    def __post_init__(self) -> None:
        for name in ("max_speed_kmh", "max_ramp_kmh_per_s", "ramp_tick_s"):
            value = getattr(self, name)
            if not (math.isfinite(value) and value > 0):
                raise ValueError(f"safety.{name} must be a positive number, got {value!r}")
        if self.reconnect_attempts < 1:
            raise ValueError("safety.reconnect_attempts must be at least 1")
        if self.reconnect_backoff_s < 0:
            raise ValueError("safety.reconnect_backoff_s must not be negative")


class SafetyEventKind(enum.StrEnum):
    BELT_ABOVE_CAP = "belt_above_cap"
    BELT_WITHIN_CAP = "belt_within_cap"  # the above-cap condition cleared


@dataclass(frozen=True, slots=True)
class SafetyEvent:
    kind: SafetyEventKind
    message: str
    speed_kmh: float
    cap_kmh: float


class SafetyError(Exception):
    pass


class BeltNotRunningError(SafetyError):
    pass


class ConnectionLostError(SafetyError):
    pass


class SpeedController:
    """Wraps a PadBackend. Speeds are handled internally in integer device-resolution units."""

    def __init__(
        self, backend: PadBackend, config: SafetyConfig, clock: Clock | None = None
    ) -> None:
        self.backend = backend
        self.config = config
        self.clock: Clock = clock or MonotonicClock()

        rng = backend.speed_range
        self._res = rng.resolution_kmh
        self._min_units = math.ceil(rng.min_kmh / self._res - 1e-9)
        self._max_units = math.floor(min(config.max_speed_kmh, rng.max_kmh) / self._res + 1e-9)
        if self._max_units < self._min_units:
            raise ValueError(
                f"max_speed_kmh {config.max_speed_kmh} is below the device minimum {rng.min_kmh}"
            )
        self._max_step_units = math.floor(
            config.max_ramp_kmh_per_s * config.ramp_tick_s / self._res + 1e-9
        )
        if self._max_step_units < 1:
            raise ValueError(
                "max_ramp_kmh_per_s * ramp_tick_s is smaller than the device speed resolution "
                f"({self._res} km/h); use a longer ramp_tick_s"
            )

        self._target_units: int | None = None
        self._commanded_units: int | None = None
        self._ramp_task: asyncio.Task[None] | None = None
        self._controlling_client: str | None = None
        self._connection_lost = False
        self._above_cap = False
        self._event_listeners: list[Callable[[SafetyEvent], None]] = []
        self.recovery_task: asyncio.Task[bool] | None = None
        backend.add_connection_lost_listener(self._on_connection_lost)

    @property
    def max_speed_kmh(self) -> float:
        """Effective cap: the lower of the configured cap and the device maximum."""
        return self._kmh(self._max_units)

    @property
    def target_kmh(self) -> float | None:
        return None if self._target_units is None else self._kmh(self._target_units)

    @property
    def controlling_client(self) -> str | None:
        return self._controlling_client

    @property
    def belt_above_cap(self) -> bool:
        return self._above_cap

    def add_event_listener(self, callback: Callable[[SafetyEvent], None]) -> None:
        """`callback` receives SafetyEvents (e.g. for pushing to the UI)."""
        self._event_listeners.append(callback)

    def observe(self, sample: Sample) -> None:
        """Feed every live sample here so above-cap belts are detected."""
        self._check_cap(sample.speed_kmh)

    def clamp(self, kmh: float) -> float:
        """The speed a request would actually be clamped to. Raises on nonsense input."""
        return self._kmh(self._to_units(kmh))

    async def start(self, client: str | None = None) -> None:
        self._check_usable()
        self._claim(client)
        await self.backend.start()
        # The device starts the belt at its minimum speed; ramp from there.
        self._commanded_units = self._min_units
        self._target_units = None

    async def set_speed(self, kmh: float, client: str | None = None) -> float:
        """Ramp towards `kmh` (clamped to cap and device range). Returns the effective target.

        Returns immediately; use `wait_until_reached()` to wait for the ramp. 0 means stop.
        """
        self._check_usable()
        if kmh == 0:
            await self.stop(client)
            return 0.0
        units = self._to_units(kmh)
        if self.backend.belt_state is not BeltState.RUNNING:
            raise BeltNotRunningError("belt is not running; start it first")
        if abs(self._kmh(units) - kmh) > 1e-9:
            log.warning("requested %.2f km/h, clamped to %.1f km/h", kmh, self._kmh(units))
        self._claim(client)
        self._target_units = units
        if self._ramp_task is None or self._ramp_task.done():
            self._ramp_task = asyncio.create_task(self._ramp())
        return self._kmh(units)

    async def wait_until_reached(self) -> None:
        if self._ramp_task is not None:
            await self._ramp_task

    async def stop(self, client: str | None = None) -> None:
        """Stop the belt now. Always allowed (no ramp; the pad decelerates on its own)."""
        await self._cancel_ramp()
        self._claim(client)
        await self.backend.stop()

    async def client_disconnected(self, client: str) -> None:
        """Call when a client goes away. Stops the belt if that client was in control."""
        if client != self._controlling_client:
            return
        self._controlling_client = None
        if self.backend.is_connected and self.backend.belt_state is not BeltState.STOPPED:
            log.warning("controlling client %r disconnected; stopping belt", client)
            await self.stop()

    async def close(self) -> None:
        """Stop the belt if needed and disconnect."""
        await self._cancel_ramp()
        if self.backend.is_connected:
            if self.backend.belt_state is not BeltState.STOPPED:
                await self.backend.stop()
            await self.backend.disconnect()

    # --- internals --------------------------------------------------------------------------

    def _kmh(self, units: int) -> float:
        return round(units * self._res, 6)

    def _to_units(self, kmh: float) -> int:
        if not math.isfinite(kmh) or kmh < 0:
            raise ValueError(f"invalid speed {kmh!r}")
        return max(self._min_units, min(self._max_units, round(kmh / self._res)))

    def _check_usable(self) -> None:
        if self._connection_lost:
            raise ConnectionLostError("pad connection lost; waiting for recovery")

    def _claim(self, client: str | None) -> None:
        if client is not None:
            self._controlling_client = client

    def _check_cap(self, speed_kmh: float) -> None:
        above = speed_kmh > self.max_speed_kmh + self._res / 2
        if above == self._above_cap:
            return  # report transitions only, not every sample
        self._above_cap = above
        cap = self.max_speed_kmh
        if above:
            kind = SafetyEventKind.BELT_ABOVE_CAP
            message = f"belt at {speed_kmh:.1f} km/h is above the {cap:.1f} km/h cap"
            log.warning(message)
        else:
            kind = SafetyEventKind.BELT_WITHIN_CAP
            message = f"belt back within the {cap:.1f} km/h cap"
            log.info(message)
        event = SafetyEvent(kind, message, speed_kmh, cap)
        for callback in list(self._event_listeners):
            try:
                callback(event)
            except Exception:
                log.exception("safety event listener failed")

    async def _ramp(self) -> None:
        self._check_cap(self.backend.speed_kmh)
        if self._commanded_units is None:
            # Belt was already running when we took over: ramp from its actual speed.
            self._commanded_units = max(
                self._min_units, round(self.backend.speed_kmh / self._res)
            )
        while self._target_units is not None and self._commanded_units != self._target_units:
            await self.clock.sleep(self.config.ramp_tick_s)
            if self._target_units is None:
                break
            diff = self._target_units - self._commanded_units
            step = max(-self._max_step_units, min(self._max_step_units, diff))
            next_units = self._commanded_units + step
            await self.backend.set_speed(self._kmh(next_units))
            self._commanded_units = next_units

    async def _cancel_ramp(self) -> None:
        self._target_units = None
        self._commanded_units = None
        task, self._ramp_task = self._ramp_task, None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    def _on_connection_lost(self) -> None:
        log.error("pad connection lost; will reconnect and stop the belt")
        self._connection_lost = True
        self._target_units = None
        self._commanded_units = None
        if self._ramp_task is not None:
            self._ramp_task.cancel()
            self._ramp_task = None
        self.recovery_task = asyncio.get_running_loop().create_task(self._recover())

    async def _recover(self) -> bool:
        attempts = self.config.reconnect_attempts
        for attempt in range(1, attempts + 1):
            try:
                await self.backend.connect()
                # Belt state is stale after a drop, so always send stop.
                await self.backend.stop()
            except BackendError as exc:
                log.error("reconnect attempt %d/%d failed: %s", attempt, attempts, exc)
                if attempt < attempts:
                    await self.clock.sleep(self.config.reconnect_backoff_s * attempt)
                continue
            self._connection_lost = False
            self._controlling_client = None
            log.warning("reconnected to pad and stopped the belt")
            return True
        log.critical("could not reconnect to stop the belt. STOP THE PAD MANUALLY.")
        return False
