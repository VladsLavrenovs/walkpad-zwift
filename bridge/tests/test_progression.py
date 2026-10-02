"""Open-world progression: XP from walking and discoveries, levels, achievements."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from test_server import H, make_client
from test_worlds import save
from walkpad_bridge import progression
from conftest import VirtualClock, run_until
from walkpad_bridge.config import Config, StorageConfig
from walkpad_bridge.fake import FakeBackend
from walkpad_bridge.service import BridgeService
from walkpad_bridge.storage import Store, Totals

TUNNEL = {**H, "Cf-Connecting-Ip": "8.8.8.8"}


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with make_client(tmp_path) as c:
        yield c


def test_levels() -> None:
    assert [progression.level_start(n) for n in (1, 2, 3, 4, 10)] == [0, 100, 300, 600, 4500]
    assert progression.level_for(0) == 1
    assert progression.level_for(99) == 1
    assert progression.level_for(100) == 2
    assert progression.level_for(4499) == 9
    assert progression.level_for(4500) == 10


def test_discovery_xp_and_validation() -> None:
    assert progression.discovery_xp("place", "castle-3") == 100
    assert progression.discovery_xp("place", "windmill-12") == 25
    assert progression.discovery_xp("province", "4") == 150
    assert progression.discovery_xp("biome", "falls") == 100
    for kind, key in [("place", "dragon-1"), ("place", "castle"), ("province", "x"), ("biome", "city"), ("cave", "1")]:
        assert progression.discovery_xp(kind, key) is None


def test_a_new_walker_is_level_1(client: TestClient) -> None:
    p = client.get("/game/profile").json()
    assert (p["xp"], p["level"], p["level_start_xp"], p["next_level_xp"]) == (0, 1, 0, 100)
    assert all(a["unlocked_at"] is None for a in p["achievements"])
    assert len(p["achievements"]) == len(progression.ACHIEVEMENTS)


def test_discoveries_give_xp_once_and_unlock_achievements(client: TestClient) -> None:
    world = save(client).json()
    body = {"items": [{"kind": "place", "key": "city-0"}, {"kind": "province", "key": "2"}, {"kind": "biome", "key": "forest"}]}
    r = client.post(f"/worlds/{world['id']}/discoveries", json=body, headers=H)
    assert r.status_code == 200
    out = r.json()
    assert [(d["key"], d["xp"]) for d in out["new"]] == [("city-0", 100), ("2", 150), ("forest", 100)]
    city = next(a for a in out["profile"]["achievements"] if a["id"] == "city-lights")
    assert city["unlocked_at"] is not None  # "Reach a city"
    assert out["profile"]["breakdown"] == {"walking": 0, "discoveries": 350, "achievements": 50}
    assert (out["profile"]["xp"], out["profile"]["level"]) == (400, 3)
    # The same again: nothing new, no more XP.
    again = client.post(f"/worlds/{world['id']}/discoveries", json=body, headers=H).json()
    assert again["new"] == [] and again["profile"]["xp"] == 400
    listed = client.get(f"/worlds/{world['id']}/discoveries").json()["discoveries"]
    assert {d["key"] for d in listed} == {"city-0", "2", "forest"}
    # Another world: the same place id is a different place, so it counts again.
    other = save(client, "Isle of Mist", 2024).json()
    more = client.post(f"/worlds/{other['id']}/discoveries", json={"items": [{"kind": "place", "key": "city-0"}]}, headers=H).json()
    assert len(more["new"]) == 1
    # Progress survives deleting a world.
    client.delete(f"/worlds/{other['id']}", headers=H)
    assert client.get("/game/profile").json()["breakdown"]["discoveries"] == 450


def test_bad_discoveries_are_refused(client: TestClient) -> None:
    world = save(client).json()
    url = f"/worlds/{world['id']}/discoveries"
    assert client.post(url, json={"items": [{"kind": "place", "key": "dragon-1"}]}, headers=H).status_code == 422
    assert client.post(url, json={"items": [{"kind": "cave", "key": "1"}]}, headers=H).status_code == 422
    assert client.post(url, json={"items": []}, headers=H).status_code == 422
    assert client.post("/worlds/999/discoveries", json={"items": [{"kind": "biome", "key": "forest"}]}, headers=H).status_code == 404
    # Remote (the public site) may look, not discover.
    assert client.post(url, json={"items": [{"kind": "biome", "key": "forest"}]}, headers=TUNNEL).status_code == 403
    assert client.get("/game/profile", headers={"Cf-Connecting-Ip": "8.8.8.8"}).status_code == 200


def test_walking_gives_xp_and_distance_achievements(tmp_path: Path) -> None:
    store = Store(tmp_path / "w.sqlite")
    for day in range(3):  # three days in a row, 4 km each
        sid = store.open_session(1_790_000_000 + day * 86400, "fake")
        store.close_session(sid, 1_790_000_000 + day * 86400 + 3000, Totals(duration_s=3000, distance_m=4000, steps=5000))
    from walkpad_bridge.stats import compute_stats

    stats = compute_stats(store.finished_sessions(), now=1_790_000_000 + 2 * 86400 + 4000)
    values = progression.metrics(stats, live_m=1500, discoveries=[])
    assert values["distance_km"] == pytest.approx(13.5)  # finished walks plus the one going on
    assert values["longest_session_km"] == pytest.approx(4)
    new = {a.id for a in progression.newly_unlocked(values, {})}
    assert {"first-km", "wanderer", "habit"} <= new
    assert "marathon" not in new and "good-walk" not in new
    p = progression.profile(values, [], {a: 1.0 for a in new})
    assert p["breakdown"]["walking"] == 1350  # 1 XP per 10 m
    assert p["breakdown"]["achievements"] == sum(a.xp for a in progression.ACHIEVEMENTS if a.id in new)


def test_unlocks_are_kept_even_if_the_metric_drops(tmp_path: Path) -> None:
    store = Store(tmp_path / "w.sqlite")
    store.unlock_achievements(["wanderer"], 5)
    store.unlock_achievements(["wanderer"], 9)  # not twice, not re-dated
    assert store.unlocked_achievements() == {"wanderer": 5}
    values = progression.metrics(
        {"all_time": {"distance_m": 0, "sessions": 0}, "personal_bests": {"longest_distance_m": None},
         "streaks": {"longest_days": 0}}, 0, [])
    p = progression.profile(values, [], store.unlocked_achievements())
    assert p["breakdown"]["achievements"] == 150


def test_v7_database_gains_the_progression_tables(tmp_path: Path) -> None:
    path = tmp_path / "v7.sqlite"
    db = sqlite3.connect(path)
    db.executescript("CREATE TABLE videos (id INTEGER PRIMARY KEY, video_id TEXT); PRAGMA user_version = 7;")
    db.close()
    store = Store(path)
    assert store.db.execute("PRAGMA user_version").fetchone()[0] == 8
    assert store.add_discoveries(1, [("biome", "forest", 100)], now=3)[0]["xp"] == 100


async def test_the_walk_going_on_counts_before_it_ends(tmp_path: Path, clock: VirtualClock) -> None:
    fake = FakeBackend(clock=clock, seed=1)
    service = BridgeService(fake, Config(storage=StorageConfig(min_session_s=0)), Store(tmp_path / "w.sqlite"),
                            protocol_name="fake", clock=clock, wall_clock=lambda: 1_790_000_000 + clock.t)
    await service.start()
    await run_until(lambda: service.controller is not None)
    service.client_connected("page")
    await service.control_start("page", 3.6)
    await run_until(lambda: fake.speed_kmh == 3.6, max_yields=100_000)
    t0 = clock.t
    await run_until(lambda: clock.t > t0 + 120, max_yields=200_000)
    assert service.recorder.session_id is not None  # still walking
    p = service.game_profile()
    assert p["metrics"]["distance_km"] > 0.08
    assert p["breakdown"]["walking"] >= 8
    await service.close()
