"""Turns the live sample stream into stored sessions. Sessions start and end with the belt.

- Opens a session on the first sample with the belt moving (the start countdown does not count).
- Closes it when the pad reports the belt stopped, or when the pad connection goes away. After a
  dropped connection the belt usually keeps going; if the pad is back within RESUME_WINDOW_S
  and its counters kept counting, the same session continues (instead of a second session that
  would count the same minutes twice; seen on hardware).
- Stores at most one sample per second.
- Session totals come from the pad's own counters. Those reset during a session sometimes
  (the owner's pad zeroes time and distance while the belt is still slowing down), so a counter
  that goes backwards adds its last value to an offset instead of shrinking the total.
- Sessions shorter than `min_session_s` (a quick start/stop) are deleted when they end.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass

from .backend import BeltState, Sample
from .storage import Store, Totals

log = logging.getLogger(__name__)

SAMPLE_INTERVAL_S = 1.0
RESUME_WINDOW_S = 60.0


class _Counter:
    """A pad counter that may reset to zero; `total` keeps counting across resets."""

    def __init__(self) -> None:
        self.offset = 0.0
        self.last = 0.0

    def update(self, value: float) -> float:
        if value < self.last:
            self.offset += self.last
        self.last = value
        return self.offset + value


@dataclass
class _Paused:
    """A session closed by a lost pad connection, kept so a quick reconnect can resume it."""

    session_id: int
    at: float
    elapsed: _Counter
    distance: _Counter
    steps: _Counter
    max_speed: float
    totals: Totals
    last_stored: float | None


class SessionRecorder:
    def __init__(
        self,
        store: Store,
        protocol: str | None = None,
        min_session_s: float = 10.0,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        self.store = store
        self.protocol = protocol
        self.min_session_s = min_session_s
        self.wall_clock = wall_clock
        self.session_id: int | None = None
        self._paused: _Paused | None = None
        self._reset()

    def on_sample(self, sample: Sample) -> None:
        now = self.wall_clock()
        if self.session_id is None:
            if not (sample.belt is BeltState.RUNNING and sample.speed_kmh > 0):
                if sample.belt is BeltState.STOPPED:
                    self._finish_suspended()  # the pad came back stopped: that walk is over
                return
            if not self._resume(sample, now):
                self._finish_suspended()
                self.session_id = self.store.open_session(now, self.protocol)
                log.info("session %d started", self.session_id)
        self._last_t = now
        totals = self._update_totals(sample)
        if sample.belt is BeltState.STOPPED:
            self.end()
            return
        if self._last_stored is None or now - self._last_stored >= SAMPLE_INTERVAL_S - 0.05:
            self.store.add_sample(self.session_id, now, sample, totals)
            self._last_stored = now

    def link_lost(self) -> None:
        """The pad connection dropped. Close the session, but let a quick reconnect resume it."""
        if self.session_id is None:
            return
        paused = _Paused(
            self.session_id, self._last_t or self.wall_clock(), self._elapsed, self._distance,
            self._steps, self._max_speed, self._totals, self._last_stored,
        )
        self.store.close_session(paused.session_id, paused.at, paused.totals)
        log.info("session %d paused: pad connection lost", paused.session_id)
        self.session_id = None
        self._reset()
        self._paused = paused

    def end(self) -> None:
        """Close the open session (belt stopped or bridge shutting down)."""
        self._finish_suspended()
        if self.session_id is None:
            return
        session_id, totals = self.session_id, self._totals
        ended_at = self._last_t if self._last_t is not None else self.wall_clock()
        if totals.duration_s < self.min_session_s:
            self.store.delete_session(session_id)
            log.info("session %d discarded (%.0f s < %.0f s)", session_id, totals.duration_s,
                     self.min_session_s)
        else:
            self.store.close_session(session_id, ended_at, totals)
            log.info("session %d ended: %.0f m, %.0f s, %s steps", session_id, totals.distance_m,
                     totals.duration_s, totals.steps)
        self.session_id = None
        self._reset()

    @property
    def totals(self) -> Totals:
        return self._totals

    def _update_totals(self, sample: Sample) -> Totals:
        steps = None if sample.steps is None else int(self._steps.update(sample.steps))
        self._max_speed = max(self._max_speed, sample.speed_kmh)
        self._totals = Totals(
            duration_s=round(self._elapsed.update(sample.elapsed_s), 1),
            distance_m=round(self._distance.update(sample.distance_m), 1),
            steps=steps,
            max_speed_kmh=self._max_speed,
        )
        return self._totals

    def _resume(self, sample: Sample, now: float) -> bool:
        p = self._paused
        if p is None or now - p.at > RESUME_WINDOW_S:
            return False
        if sample.elapsed_s < p.elapsed.last:
            return False  # the pad's counters restarted: a new walk
        self._paused = None
        self.session_id = p.session_id
        self._elapsed, self._distance, self._steps = p.elapsed, p.distance, p.steps
        self._max_speed, self._totals, self._last_stored = p.max_speed, p.totals, p.last_stored
        self.store.reopen_session(p.session_id)
        log.info("session %d resumed after the reconnect", p.session_id)
        return True

    def _finish_suspended(self) -> None:
        """The paused session will not be resumed: apply the minimum-length rule to it."""
        p, self._paused = self._paused, None
        if p is not None and p.totals.duration_s < self.min_session_s:
            self.store.delete_session(p.session_id)

    def _reset(self) -> None:
        self._elapsed = _Counter()
        self._distance = _Counter()
        self._steps = _Counter()
        self._max_speed = 0.0
        self._totals = Totals()
        self._last_t: float | None = None
        self._last_stored: float | None = None
