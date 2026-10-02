"""Open world: saved worlds (snapshots the web app made) and the player's place in each."""

from __future__ import annotations

import gzip
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from test_server import H, make_client
from walkpad_bridge.storage import SCHEMA_VERSION, Store

SNAPSHOT = gzip.compress(b"WPW1" + bytes(range(256)) * 40)
TUNNEL = {**H, "Cf-Connecting-Ip": "8.8.8.8"}


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with make_client(tmp_path) as c:
        yield c


def save(client: TestClient, name: str = "Elderland", seed: int = 7, headers: dict[str, str] = H):  # type: ignore[no-untyped-def]
    return client.post(f"/worlds?name={name}&seed={seed}&gen_version=1", content=SNAPSHOT,
                       headers={**headers, "Content-Type": "application/octet-stream"})


def test_save_list_and_read_back_a_world(client: TestClient) -> None:
    r = save(client)
    assert r.status_code == 201
    world = r.json()
    assert (world["name"], world["seed"], world["gen_version"], world["size"]) == ("Elderland", 7, 1, len(SNAPSHOT))
    assert world["active"] is True  # the first world saved is the one you walk in
    assert world["x"] is None and world["walked_m"] == 0
    second = save(client, "Isle of Mist", 2024).json()
    assert second["active"] is False
    listed = client.get("/worlds").json()["worlds"]
    assert [w["name"] for w in listed] == ["Elderland", "Isle of Mist"]  # active first
    assert "snapshot" not in listed[0]
    snap = client.get(f"/worlds/{world['id']}/snapshot")
    assert snap.status_code == 200 and snap.content == SNAPSHOT
    assert snap.headers["content-type"] == "application/octet-stream"
    assert client.get("/worlds/999/snapshot").status_code == 404


def test_switch_rename_play_and_delete(client: TestClient) -> None:
    a = save(client).json()
    b = save(client, "Isle of Mist", 2024).json()
    worlds = client.put("/worlds/active", json={"id": b["id"]}, headers=H).json()["worlds"]
    assert [(w["name"], w["active"]) for w in worlds] == [("Isle of Mist", True), ("Elderland", False)]
    assert client.patch(f"/worlds/{a['id']}", json={"name": "Old Home"}, headers=H).json()["name"] == "Old Home"
    assert client.patch(f"/worlds/{a['id']}", json={"name": ""}, headers=H).status_code == 422
    state = {"x": 4321.5, "z": 5100.25, "heading": 1.2, "walked_m": 850}
    played = client.put(f"/worlds/{b['id']}/state", json=state, headers=H).json()
    assert (played["x"], played["z"], played["heading"], played["walked_m"]) == (4321.5, 5100.25, 1.2, 850)
    assert played["played_at"] is not None
    # Walked metres never go back (a stale tab cannot undo progress).
    again = client.put(f"/worlds/{b['id']}/state", json={**state, "walked_m": 10}, headers=H).json()
    assert again["walked_m"] == 850
    nan = '{"x": NaN, "z": 1, "heading": 0, "walked_m": 1}'
    bad = client.put(f"/worlds/{b['id']}/state", content=nan, headers={**H, "Content-Type": "application/json"})
    assert bad.status_code == 422
    assert client.delete(f"/worlds/{b['id']}", headers=H).status_code == 204
    assert client.delete(f"/worlds/{b['id']}", headers=H).status_code == 404
    assert [w["name"] for w in client.get("/worlds").json()["worlds"]] == ["Old Home"]
    assert client.put("/worlds/active", json={"id": 999}, headers=H).status_code == 404
    assert client.put("/worlds/active", json={"id": None}, headers=H).status_code == 200


def test_bad_uploads_are_refused(client: TestClient) -> None:
    plain = client.post("/worlds?name=x&seed=1&gen_version=1", content=b"not gzip", headers=H)
    assert plain.status_code == 422
    assert client.post("/worlds?name=&seed=1&gen_version=1", content=SNAPSHOT, headers=H).status_code == 422
    assert client.post("/worlds?name=x&seed=-1&gen_version=1", content=SNAPSHOT, headers=H).status_code == 422


def test_remote_may_look_but_not_change(client: TestClient) -> None:
    world = save(client).json()
    assert save(client, headers=TUNNEL).status_code == 403
    for method, path, body in [
        ("patch", f"/worlds/{world['id']}", {"name": "x"}),
        ("put", "/worlds/active", {"id": None}),
        ("put", f"/worlds/{world['id']}/state", {"x": 1, "z": 1, "heading": 0, "walked_m": 1}),
        ("delete", f"/worlds/{world['id']}", None),
    ]:
        r = client.request(method.upper(), path, json=body, headers=TUNNEL)
        assert r.status_code == 403, path
    # Reading works through the tunnel (the public site can show your world).
    assert client.get("/worlds", headers={"Cf-Connecting-Ip": "8.8.8.8"}).status_code == 200
    assert client.get(f"/worlds/{world['id']}/snapshot", headers={"Cf-Connecting-Ip": "8.8.8.8"}).status_code == 200


def test_v6_database_gains_the_worlds_table(tmp_path: Path) -> None:
    path = tmp_path / "v6.sqlite"
    db = sqlite3.connect(path)
    db.executescript("CREATE TABLE videos (id INTEGER PRIMARY KEY, video_id TEXT); PRAGMA user_version = 6;")
    db.close()
    store = Store(path)
    assert store.db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    world = store.add_world("W", 1, 1, SNAPSHOT, now=5)
    assert store.world_snapshot(world["id"]) == SNAPSHOT
    assert store.list_worlds()[0]["active"] is True
