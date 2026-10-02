"""Open-world quests from NPCs: taking, progress, finishing, XP."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from test_server import H, make_client
from test_worlds import save
from walkpad_bridge import progression
from walkpad_bridge.storage import SCHEMA_VERSION, Store

TUNNEL = {**H, "Cf-Connecting-Ip": "8.8.8.8"}


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with make_client(tmp_path) as c:
        yield c


def quest(n: int = 0, xp: int = 120, kind: str = "deliver") -> dict:  # type: ignore[type-arg]
    return {"id": f"npc-village-3-0:{n}", "title": "A letter for Ambermouth", "kind": kind,
            "data": {"to": "city-1", "distance_m": 1400}, "xp": xp}


def test_take_progress_and_finish_a_quest(client: TestClient) -> None:
    world = save(client).json()
    url = f"/worlds/{world['id']}/quests"
    r = client.post(url, json=quest(), headers=H)
    assert r.status_code == 201
    q = r.json()
    assert (q["state"], q["progress"], q["xp"], q["data"]["to"]) == ("active", 0, 120, "city-1")
    assert client.get(url).json()["quests"][0]["id"] == "npc-village-3-0:0"
    # Progress only grows; a finished quest pays its XP once.
    client.patch(f"{url}/npc-village-3-0:0", json={"progress": 700}, headers=H)
    back = client.patch(f"{url}/npc-village-3-0:0", json={"progress": 200}, headers=H).json()
    assert back["quest"]["progress"] == 700
    done = client.patch(f"{url}/npc-village-3-0:0", json={"progress": 1400, "state": "done"}, headers=H).json()
    assert done["quest"]["state"] == "done" and done["quest"]["finished_at"] is not None
    assert done["profile"]["breakdown"]["quests"] == 120
    helping = next(a for a in done["profile"]["achievements"] if a["id"] == "helping-hand")
    assert helping["unlocked_at"] is not None
    # Finished is final: no more changes, no more XP.
    again = client.patch(f"{url}/npc-village-3-0:0", json={"state": "failed"}, headers=H).json()
    assert again["quest"]["state"] == "done" and again["profile"]["breakdown"]["quests"] == 120


def test_each_quest_once_and_a_few_at_a_time(client: TestClient) -> None:
    world = save(client).json()
    url = f"/worlds/{world['id']}/quests"
    assert client.post(url, json=quest(0), headers=H).status_code == 201
    assert client.post(url, json=quest(0), headers=H).status_code == 409  # taken before
    for n in range(1, progression.MAX_ACTIVE_QUESTS):
        assert client.post(url, json=quest(n), headers=H).status_code == 201
    assert client.post(url, json=quest(99), headers=H).status_code == 409  # too many at once
    client.patch(f"{url}/npc-village-3-0:0", json={"state": "abandoned"}, headers=H)
    assert client.post(url, json=quest(99), headers=H).status_code == 201
    # An abandoned or failed quest gives nothing.
    assert client.get("/game/profile").json()["breakdown"]["quests"] == 0


def test_bad_quests_are_refused(client: TestClient) -> None:
    world = save(client).json()
    url = f"/worlds/{world['id']}/quests"
    assert client.post(url, json=quest(xp=progression.QUEST_XP_MAX + 1), headers=H).status_code == 422
    assert client.post(url, json={**quest(), "kind": "slay"}, headers=H).status_code == 422
    assert client.post(url, json={**quest(), "id": "no spaces:1"}, headers=H).status_code == 422
    assert client.post(url, json={**quest(), "data": {"x": "y" * 3000}}, headers=H).status_code == 422
    assert client.post("/worlds/999/quests", json=quest(), headers=H).status_code == 404
    assert client.patch(f"{url}/nope:1", json={"state": "done"}, headers=H).status_code == 404
    assert client.patch(f"{url}/x:1", json={"state": "active"}, headers=H).status_code == 422
    # Remote may look, not take or finish.
    assert client.post(url, json=quest(), headers=TUNNEL).status_code == 403
    assert client.get(url, headers={"Cf-Connecting-Ip": "8.8.8.8"}).status_code == 200


def test_v8_database_gains_the_quests_table(tmp_path: Path) -> None:
    path = tmp_path / "v8.sqlite"
    db = sqlite3.connect(path)
    db.executescript("CREATE TABLE videos (id INTEGER PRIMARY KEY, video_id TEXT); PRAGMA user_version = 8;")
    db.close()
    store = Store(path)
    assert store.db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    assert store.add_quest(1, "a:0", "T", "visit", {}, 50, now=1)["state"] == "active"
