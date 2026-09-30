"""Belt response lag: time from a command being sent to the pad's status showing its effect.

Resolution is limited by how often the pad reports (KingSmith: `kingsmith_poll_s`), so a lag
of 0.0-1.0 s means "by the next status". A command replaced before its effect showed (e.g. the
next ramp step) is counted as superseded, not as a lag.
"""

from __future__ import annotations

import logging
import statistics
from dataclasses import dataclass

from .backend import BeltState, Sample
from .clock import Clock

log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class LagRecord:
    command: str  # start | set_speed | stop
    kmh: float | None
    sent_at: float
    lag_s: float | None  # None: superseded before the effect showed


class LagMeter:
    def __init__(self, clock: Clock, resolution_kmh: float = 0.1) -> None:
        self.clock = clock
        self.tolerance = resolution_kmh / 2 + 1e-9
        self.records: list[LagRecord] = []
        self._pending: tuple[str, float | None, float] | None = None

    def on_command(self, name: str, kmh: float | None = None) -> None:
        if self._pending is not None:
            self._finish(None)
        self._pending = (name, kmh, self.clock.now())

    def observe(self, sample: Sample) -> None:
        if self._pending is not None and self._reached(sample):
            self._finish(self.clock.now() - self._pending[2])

    def summary(self) -> list[str]:
        lines = []
        for command in ("start", "set_speed", "stop"):
            recs = [r for r in self.records if r.command == command]
            if not recs:
                continue
            lags = [r.lag_s for r in recs if r.lag_s is not None]
            superseded = len(recs) - len(lags)
            text = f"{command:9s} n={len(recs)}"
            if lags:
                text += (
                    f"  lag min {min(lags):.1f} s, median {statistics.median(lags):.1f} s, "
                    f"max {max(lags):.1f} s"
                )
            if superseded:
                text += f"  ({superseded} superseded before the belt got there)"
            lines.append(text)
        if self._pending is not None:
            name, kmh, _ = self._pending
            target = f" {kmh:.1f} km/h" if kmh is not None else ""
            lines.append(f"last command ({name}{target}) never showed in the pad's status")
        return lines

    def _reached(self, sample: Sample) -> bool:
        assert self._pending is not None
        name, kmh, _ = self._pending
        if name == "start":
            return sample.speed_kmh > 0
        if name == "stop":
            return sample.speed_kmh == 0 and sample.belt is BeltState.STOPPED
        assert kmh is not None
        return abs(sample.speed_kmh - kmh) <= self.tolerance

    def _finish(self, lag_s: float | None) -> None:
        assert self._pending is not None
        name, kmh, sent_at = self._pending
        self._pending = None
        self.records.append(LagRecord(name, kmh, sent_at, lag_s))
        target = f" {kmh:.1f} km/h" if kmh is not None else ""
        if lag_s is None:
            log.info("lag: %s%s superseded before the belt got there", name, target)
        else:
            log.info("lag: %s%s showed after %.1f s", name, target, lag_s)
