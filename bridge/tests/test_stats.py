from datetime import datetime, timezone

from walkpad_bridge.stats import compute_stats

UTC = timezone.utc


def ts(day: str, hour: int = 12) -> float:
    return datetime.fromisoformat(f"{day}T{hour:02d}:00:00+00:00").timestamp()


def s(id: int, day: str, dist: float, dur: float, steps: int | None = 100) -> dict:
    return {"id": id, "started_at": ts(day), "distance_m": dist, "duration_s": dur, "steps": steps,
            "avg_speed_kmh": round(dist / dur * 3.6, 2) if dur else 0.0}


SESSIONS = [
    s(1, "2026-08-15", 3000, 3600),
    s(2, "2026-09-26", 1000, 600),  # Sat
    s(3, "2026-09-27", 500, 300),   # Sun
    s(4, "2026-09-28", 2000, 1200),  # Mon
    s(5, "2026-09-28", 900, 30, None),  # short, no steps
    s(6, "2026-09-29", 100, 50),    # under a minute: not an active day on its own
]
NOW = ts("2026-09-30", 9)  # Wednesday, nothing walked yet today


def test_period_totals() -> None:
    st = compute_stats(SESSIONS, now=NOW, tz=UTC)
    assert st["today"] == "2026-09-30"
    daily = {d["date"]: d for d in st["daily"]}
    assert len(daily) == 7 and "2026-09-24" in daily
    assert daily["2026-09-28"] == {"date": "2026-09-28", "sessions": 2, "distance_m": 2900.0,
                                   "duration_s": 1230.0, "steps": 100}
    weeks = {w["week_start"]: w for w in st["weekly"]}
    assert len(weeks) == 8
    assert weeks["2026-09-28"]["distance_m"] == 3000.0  # Mon-Wed
    assert weeks["2026-09-21"]["distance_m"] == 1500.0  # the weekend before
    months = {m["month"]: m for m in st["monthly"]}
    assert len(months) == 12 and "2025-10" in months
    assert months["2026-08"]["distance_m"] == 3000.0
    assert months["2026-09"]["sessions"] == 5
    assert st["all_time"]["distance_m"] == 7500.0


def test_streaks() -> None:
    st = compute_stats(SESSIONS, now=NOW, tz=UTC)["streaks"]
    # 26, 27, 28 active; 29 too short; today not walked yet -> current counts from yesterday.
    assert (st["current_days"], st["longest_days"], st["walked_today"]) == (0, 3, False)
    more = SESSIONS + [s(7, "2026-09-29", 800, 600)]
    st = compute_stats(more, now=NOW, tz=UTC)["streaks"]
    assert (st["current_days"], st["longest_days"]) == (4, 4)
    st = compute_stats(more + [s(8, "2026-09-30", 100, 70)], now=NOW, tz=UTC)["streaks"]
    assert (st["current_days"], st["walked_today"]) == (5, True)


def test_personal_bests() -> None:
    pb = compute_stats(SESSIONS, now=NOW, tz=UTC)["personal_bests"]
    assert pb["longest_distance_m"] == {"session_id": 1, "value": 3000, "date": "2026-08-15"}
    assert pb["longest_duration_s"]["session_id"] == 1
    assert pb["most_steps"]["value"] == 100
    # Session 5 averages 108 km/h over 30 s (nonsense) but is too short to count.
    assert pb["fastest_avg_speed_kmh"]["session_id"] in (2, 4)
    assert pb["best_day_distance_m"] == {"date": "2026-08-15", "value": 3000.0}


def test_empty() -> None:
    st = compute_stats([], now=NOW, tz=UTC)
    assert st["streaks"]["current_days"] == 0
    assert st["personal_bests"]["longest_distance_m"] is None
    assert st["personal_bests"]["best_day_distance_m"] is None
