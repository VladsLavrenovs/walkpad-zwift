"""Google 3D tiles cost guard: counting, limits, day and month rollover, the API."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from test_server import make_client
from walkpad_bridge.storage import Store
from walkpad_bridge.tiles3d import Tiles3dGuard, period_keys

UTC = timezone.utc


def at(iso: str) -> float:
    return datetime.fromisoformat(iso).replace(tzinfo=UTC).timestamp()


class Clock:
    def __init__(self, iso: str) -> None:
        self.t = at(iso)

    def __call__(self) -> float:
        return self.t


def guard(tmp_path: Path, clock: Clock, per_day: int = 3, per_month: int = 5) -> Tiles3dGuard:
    return Tiles3dGuard(Store(tmp_path / "w.sqlite"), per_day, per_month, clock, tz=UTC)


def test_period_keys() -> None:
    assert period_keys(at("2026-10-01T23:59:59"), UTC) == ("2026-10-01", "2026-10")
    assert period_keys(at("2026-12-31T23:59:59"), UTC) == ("2026-12-31", "2026-12")


def test_counts_and_refuses_over_the_daily_limit(tmp_path: Path) -> None:
    clock = Clock("2026-10-01T09:00:00")
    g = guard(tmp_path, clock)
    grants = [g.request("page") for _ in range(4)]
    assert [x.granted for x in grants] == [True, True, True, False]
    assert grants[2].usage["today"] == 3
    refused = grants[3]
    assert refused.reason == "day"
    assert refused.message == "3D world limit reached — resets tomorrow"
    assert g.usage()["today"] == 3  # refusals are not counted


def test_new_day_resets_the_daily_count(tmp_path: Path) -> None:
    clock = Clock("2026-10-01T23:58:00")
    g = guard(tmp_path, clock)
    for _ in range(3):
        assert g.request(None).granted
    assert not g.request(None).granted
    clock.t = at("2026-10-02T00:00:01")  # midnight passed
    grant = g.request(None)
    assert grant.granted and grant.usage["today"] == 1 and grant.usage["this_month"] == 4


def test_monthly_limit_and_month_rollover(tmp_path: Path) -> None:
    clock = Clock("2026-10-30T10:00:00")
    g = guard(tmp_path, clock)
    for _ in range(3):
        assert g.request(None).granted
    clock.t = at("2026-10-31T10:00:00")
    assert g.request(None).granted and g.request(None).granted  # month total 5
    refused = g.request(None)
    assert (refused.granted, refused.reason) == (False, "month")
    assert refused.message == "3D world limit reached — resets next month"
    clock.t = at("2026-11-01T00:00:01")
    grant = g.request(None)
    assert grant.granted and grant.usage == {
        "day": "2026-11-01", "month": "2026-11", "today": 1, "this_month": 1, "per_day": 3, "per_month": 5,
    }


def test_month_limit_wins_when_both_are_reached(tmp_path: Path) -> None:
    clock = Clock("2026-10-01T10:00:00")
    g = guard(tmp_path, clock, per_day=2, per_month=2)
    assert g.request(None).granted and g.request(None).granted
    assert g.request(None).reason == "month"  # "next month", not "tomorrow"


def test_year_rollover(tmp_path: Path) -> None:
    clock = Clock("2026-12-31T22:00:00")
    g = guard(tmp_path, clock, per_day=1, per_month=1)
    assert g.request(None).granted
    assert not g.request(None).granted
    clock.t = at("2027-01-01T00:30:00")
    assert g.request(None).granted


def test_zero_disables_the_3d_world(tmp_path: Path) -> None:
    g = guard(tmp_path, Clock("2026-10-01T10:00:00"), per_day=0, per_month=900)
    assert g.request(None).reason == "day"


def test_counts_survive_a_restart(tmp_path: Path) -> None:
    clock = Clock("2026-10-01T10:00:00")
    guard(tmp_path, clock).request("a")
    assert guard(tmp_path, clock).usage()["today"] == 1


def test_api(tmp_path: Path) -> None:
    with make_client(tmp_path, peer=("8.8.8.8", 1)) as c:  # anyone may ask; every grant counts
        assert c.get("/tiles3d/usage").json()["today"] == 0
        for i in range(25):
            r = c.post("/tiles3d/session")
            assert r.status_code == 200, (i, r.text)
        assert r.json() == {"granted": True, "usage": r.json()["usage"]}
        assert r.json()["usage"]["today"] == 25
        refused = c.post("/tiles3d/session", headers={"X-Client-Id": "obs"})
        assert refused.status_code == 429
        assert refused.json()["detail"] == "3D world limit reached — resets tomorrow"
        assert refused.json()["reason"] == "day"
        usage = c.get("/tiles3d/usage").json()
        assert (usage["today"], usage["per_day"], usage["per_month"]) == (25, 25, 900)


@pytest.mark.parametrize("bad", ["-1", "2.5"])
def test_bad_limits_rejected(tmp_path: Path, bad: str) -> None:
    from walkpad_bridge.config import load_config

    path = tmp_path / "config.toml"
    path.write_text(f"[google_3d]\nmax_sessions_per_day = {bad}\n")
    with pytest.raises(ValueError):
        load_config(path)
