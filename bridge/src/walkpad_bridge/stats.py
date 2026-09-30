"""Statistics over finished sessions: period totals, streaks, personal bests.

Days, weeks (Monday start) and months are in the bridge machine's local time unless `tz` is
given. A day counts towards a streak when its sessions add up to at least ACTIVE_DAY_S.
"""

from __future__ import annotations

import time
from collections import defaultdict
from collections.abc import Iterable
from datetime import date, datetime, timedelta, tzinfo
from typing import Any

ACTIVE_DAY_S = 60.0
BEST_AVG_SPEED_MIN_S = 300.0  # fastest average only counts sessions of 5+ minutes
DAYS, WEEKS, MONTHS = 7, 8, 12


def _empty() -> dict[str, float]:
    return {"sessions": 0, "distance_m": 0.0, "duration_s": 0.0, "steps": 0}


def _add(bucket: dict[str, float], s: dict[str, Any]) -> None:
    bucket["sessions"] += 1
    bucket["distance_m"] += s["distance_m"]
    bucket["duration_s"] += s["duration_s"]
    bucket["steps"] += s["steps"] or 0


def _rounded(bucket: dict[str, float]) -> dict[str, float]:
    return {k: round(v, 1) if isinstance(v, float) else v for k, v in bucket.items()}


def _month_back(d: date, n: int) -> date:
    month = d.year * 12 + d.month - 1 - n
    return date(month // 12, month % 12 + 1, 1)


def compute_stats(
    sessions: Iterable[dict[str, Any]], now: float | None = None, tz: tzinfo | None = None
) -> dict[str, Any]:
    sessions = list(sessions)
    today = datetime.fromtimestamp(time.time() if now is None else now, tz).date()

    by_day: dict[date, dict[str, float]] = defaultdict(_empty)
    for s in sessions:
        _add(by_day[datetime.fromtimestamp(s["started_at"], tz).date()], s)

    daily = []
    for i in range(DAYS - 1, -1, -1):
        d = today - timedelta(days=i)
        daily.append({"date": d.isoformat(), **_rounded(by_day.get(d, _empty()))})

    this_monday = today - timedelta(days=today.weekday())
    weekly = []
    for i in range(WEEKS - 1, -1, -1):
        start = this_monday - timedelta(weeks=i)
        bucket = _empty()
        for d, day in by_day.items():
            if start <= d < start + timedelta(days=7):
                for k in bucket:
                    bucket[k] += day[k]
        weekly.append({"week_start": start.isoformat(), **_rounded(bucket)})

    monthly = []
    for i in range(MONTHS - 1, -1, -1):
        first = _month_back(today, i)
        bucket = _empty()
        for d, day in by_day.items():
            if (d.year, d.month) == (first.year, first.month):
                for k in bucket:
                    bucket[k] += day[k]
        monthly.append({"month": first.strftime("%Y-%m"), **_rounded(bucket)})

    total = _empty()
    for s in sessions:
        _add(total, s)

    return {
        "today": today.isoformat(),
        "daily": daily,
        "weekly": weekly,
        "monthly": monthly,
        "streaks": _streaks(by_day, today),
        "personal_bests": _bests(sessions, by_day, tz),
        "all_time": _rounded(total),
    }


def _streaks(by_day: dict[date, dict[str, float]], today: date) -> dict[str, Any]:
    active = sorted(d for d, day in by_day.items() if day["duration_s"] >= ACTIVE_DAY_S)
    longest, run, prev = 0, 0, None
    for d in active:
        run = run + 1 if prev is not None and d - prev == timedelta(days=1) else 1
        longest = max(longest, run)
        prev = d
    # The current streak survives until today is over: count back from today, or from
    # yesterday if today has no walk yet.
    active_set = set(active)
    day = today if today in active_set else today - timedelta(days=1)
    current = 0
    while day in active_set:
        current += 1
        day -= timedelta(days=1)
    return {
        "current_days": current,
        "longest_days": longest,
        "walked_today": today in active_set,
        "active_day_min_s": ACTIVE_DAY_S,
    }


def _best(sessions: list[dict[str, Any]], key: str, tz: tzinfo | None) -> dict[str, Any] | None:
    candidates = [s for s in sessions if s.get(key) is not None]
    if not candidates:
        return None
    s = max(candidates, key=lambda s: s[key])
    return {
        "session_id": s["id"],
        "value": s[key],
        "date": datetime.fromtimestamp(s["started_at"], tz).date().isoformat(),
    }


def _bests(
    sessions: list[dict[str, Any]], by_day: dict[date, dict[str, float]], tz: tzinfo | None
) -> dict[str, Any]:
    long_enough = [s for s in sessions if s["duration_s"] >= BEST_AVG_SPEED_MIN_S]
    best_day = max(by_day.items(), key=lambda kv: kv[1]["distance_m"], default=None)
    return {
        "longest_distance_m": _best(sessions, "distance_m", tz),
        "longest_duration_s": _best(sessions, "duration_s", tz),
        "most_steps": _best(sessions, "steps", tz),
        "fastest_avg_speed_kmh": _best(long_enough, "avg_speed_kmh", tz),
        "best_day_distance_m": (
            {"date": best_day[0].isoformat(), "value": round(best_day[1]["distance_m"], 1)}
            if best_day is not None else None
        ),
    }
