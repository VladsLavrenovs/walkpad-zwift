"""Routes: GPX, geometry, progress, storage, ORS planning (faked) and the API."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from conftest import VirtualClock, run_until
from test_server import H, make_client
from walkpad_bridge import ors
from walkpad_bridge.backend import BeltState
from walkpad_bridge.config import Config, StorageConfig
from walkpad_bridge.fake import FakeBackend
from walkpad_bridge.routes import RouteProgress, clean_points, haversine_m, parse_gpx, route_length_m
from walkpad_bridge.secrets import get_secret
from walkpad_bridge.service import BridgeService
from walkpad_bridge.storage import Store

# About 111 m per 0.001 degree of latitude.
LINE = [(56.9500, 24.1000), (56.9510, 24.1000), (56.9520, 24.1000)]

GPX11 = b"""<?xml version="1.0"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Old Town loop</name></metadata>
  <trk><name>track name</name>
    <trkseg><trkpt lat="56.9500" lon="24.1000"/><trkpt lat="56.9510" lon="24.1000"/></trkseg>
    <trkseg><trkpt lat="56.9510" lon="24.1000"/><trkpt lat="56.9520" lon="24.1000"/></trkseg>
  </trk>
</gpx>"""

GPX10_ROUTE = b"""<gpx version="1.0" xmlns="http://www.topografix.com/GPX/1/0">
  <rte><rtept lat="56.95" lon="24.10"/><rtept lat="56.952" lon="24.10"/></rte></gpx>"""


def test_geometry() -> None:
    assert haversine_m(LINE[0], LINE[1]) == pytest.approx(111.2, abs=0.5)
    assert route_length_m(LINE) == pytest.approx(222.4, abs=1)


def test_clean_points() -> None:
    pts = clean_points([(56.95, 24.1), (56.9500001, 24.1), (56.951, 24.1)])
    assert pts == [(56.95, 24.1), (56.951, 24.1)]  # the near-duplicate is dropped
    for bad in ([(56.95, 24.1)], [(91, 0), (0, 0)], [(float("nan"), 0), (0, 0)]):
        with pytest.raises(ValueError):
            clean_points(bad)


def test_parse_gpx() -> None:
    gpx = parse_gpx(GPX11)
    assert gpx.name == "Old Town loop"
    assert gpx.points == LINE  # segments joined, the repeated joint point dropped
    assert parse_gpx(GPX10_ROUTE).points == [(56.95, 24.1), (56.952, 24.1)]  # route points
    for bad in (b"<html/>", b"not xml", b"<gpx><trk></trk></gpx>", b'<gpx><trkpt lat="x" lon="1"/></gpx>'):
        with pytest.raises(ValueError):
            parse_gpx(bad)


def test_route_progress_counts_only_new_distance(tmp_path: Path) -> None:
    store = Store(tmp_path / "w.sqlite")
    route = store.add_route("r", "gpx", LINE, 222.4, now=1)
    store.set_active_route(route["id"])
    p = RouteProgress(store, lambda: 5.0)
    assert p.on_distance(None, 0) is None
    assert p.on_distance(1, 0) is None  # first sample of a session: baseline
    assert p.on_distance(1, 50)["progress_m"] == 50
    assert p.on_distance(1, 50) is None  # no movement
    assert p.on_distance(1, 40) is None  # counter went back: ignored
    assert p.on_distance(1, 60)["progress_m"] == 60  # counts from the highest seen (50)
    assert p.on_distance(2, 500) is None  # new session: baseline, even if it starts high
    done = p.on_distance(2, 800)
    assert done["progress_m"] == pytest.approx(222.4)  # stops at the end
    assert done["completed_at"] == 5.0


def test_store_routes(tmp_path: Path) -> None:
    store = Store(tmp_path / "w.sqlite")
    a = store.add_route("A", "gpx", LINE, 222.4, now=1)
    b = store.add_route("B", "ors", LINE, 222.4, now=2)
    assert "points" not in a
    assert store.get_route(a["id"])["points"] == [list(p) for p in LINE]
    assert store.active_route() is None
    assert store.set_active_route(a["id"]) and store.active_route()["id"] == a["id"]
    assert store.set_active_route(b["id"]) and [r["active"] for r in store.list_routes()] == [True, False]
    assert not store.set_active_route(999) and store.active_route()["id"] == b["id"]
    assert store.set_active_route(None) and store.active_route() is None
    store.set_active_route(a["id"])
    store.advance_active_route(300, now=3)
    assert store.get_route(a["id"], with_points=False)["completed_at"] == 3
    reset = store.update_route(a["id"], "A2", 0)
    assert (reset["name"], reset["progress_m"], reset["completed_at"]) == ("A2", 0, None)
    assert store.delete_route(a["id"]) and store.active_route() is None


def test_secrets_from_dotenv(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    env = tmp_path / ".env"
    env.write_text("# comment\nexport ORS_API_KEY='abc123'\nOTHER=1\n")
    monkeypatch.delenv("ORS_API_KEY", raising=False)
    assert get_secret("ORS_API_KEY", env) == "abc123"
    monkeypatch.setenv("ORS_API_KEY", "fromenv")
    assert get_secret("ORS_API_KEY", env) == "fromenv"
    assert get_secret("MISSING", tmp_path / "none") is None


ORS_ANSWER = {"type": "FeatureCollection", "features": [{
    "geometry": {"type": "LineString", "coordinates": [[24.1, 56.95, 10], [24.1, 56.951], [24.1, 56.952]]},
    "properties": {"summary": {"distance": 222.4}}}]}


class FakeOrs:
    def __init__(self, status: int = 200, body: object = ORS_ANSWER) -> None:
        self.status, self.body, self.calls = status, body, []

    def __call__(self, url: str, body: bytes, headers: dict[str, str]) -> tuple[int, bytes]:
        self.calls.append((url, json.loads(body), headers))
        return self.status, json.dumps(self.body).encode()


async def test_plan_walk_calls_ors_with_lon_lat() -> None:
    fake = FakeOrs()
    planned = await ors.plan_walk([(56.95, 24.1), (56.952, 24.1)], fake, key="k")
    url, body, headers = fake.calls[0]
    assert "foot-walking" in url and body == {"coordinates": [[24.1, 56.95], [24.1, 56.952]]}
    assert headers["Authorization"] == "k"
    assert planned.points == LINE and planned.distance_m == pytest.approx(222.4, abs=1)


@pytest.mark.parametrize(("status", "body", "message"), [
    (401, {"error": "Access to this API has been disallowed"}, "key is wrong"),
    (429, {"error": "Rate limit exceeded"}, "quota"),
    (404, {"error": {"code": 2010, "message": "No routable point within 350m of k-secret"}}, "***"),
    (200, {"features": []}, "unexpected answer"),
])
async def test_plan_walk_errors_are_readable_and_never_leak_the_key(  # type: ignore[no-untyped-def]
    status, body, message
) -> None:
    with pytest.raises(ors.OrsError, match=message.replace("*", r"\*")) as info:
        await ors.plan_walk([(56.95, 24.1), (56.952, 24.1)], FakeOrs(status, body), key="k-secret")
    assert "k-secret" not in str(info.value)


async def test_plan_walk_without_a_key(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ors, "get_secret", lambda name: None)
    with pytest.raises(ors.OrsError, match="ORS_API_KEY is missing"):
        await ors.plan_walk(LINE[:2], FakeOrs())


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    fake = FakeOrs()

    async def plan(waypoints):  # type: ignore[no-untyped-def]
        return await ors.plan_walk(waypoints, fake, key="k")

    monkeypatch.setattr("walkpad_bridge.server.plan_walk", plan)
    with make_client(tmp_path) as c:
        yield c


def test_routes_api(client: TestClient) -> None:
    r = client.post("/routes/gpx", content=GPX11, headers={**H, "Content-Type": "application/gpx+xml"})
    assert r.status_code == 201
    gpx = r.json()
    assert (gpx["name"], gpx["source"], round(gpx["distance_m"])) == ("Old Town loop", "gpx", 222)
    named = client.post("/routes/gpx?name=Evening", content=GPX11, headers=H).json()
    assert named["name"] == "Evening"
    assert client.post("/routes/gpx", content=b"<html/>", headers=H).status_code == 422

    plan = client.post("/routes/plan", json={"waypoints": [[56.95, 24.1], [56.952, 24.1]]}, headers=H)
    assert plan.status_code == 200 and len(plan.json()["points"]) == 3
    saved = client.post("/routes", json={"name": "Planned", "points": plan.json()["points"]}, headers=H)
    assert saved.status_code == 201 and saved.json()["source"] == "ors"
    assert client.post("/routes/plan", json={"waypoints": [[99, 0], [0, 0]]}, headers=H).status_code == 422

    assert client.put("/routes/active", json={"id": saved.json()["id"]}, headers=H).status_code == 200
    status = client.get("/status").json()
    assert status["route"]["name"] == "Planned" and status["route"]["progress_m"] == 0
    r = client.patch(f"/routes/{saved.json()['id']}", json={"progress_m": 100}, headers=H)
    assert r.json()["progress_m"] == 100
    listed = client.get("/routes").json()["routes"]
    assert listed[0]["active"] and "points" not in listed[0]
    assert client.get(f"/routes/{gpx['id']}").json()["points"][0] == [56.95, 24.1]
    assert client.put("/routes/active", json={"id": 999}, headers=H).status_code == 404
    assert client.delete(f"/routes/{saved.json()['id']}", headers=H).status_code == 204
    assert client.get("/status").json()["route"] is None


def test_routes_are_read_only_from_outside(client: TestClient) -> None:
    tunnel = {**H, "Cf-Connecting-Ip": "8.8.8.8"}
    assert client.post("/routes/gpx", content=GPX11, headers=tunnel).status_code == 403
    plan = {"waypoints": [[56.95, 24.1], [56.952, 24.1]]}
    assert client.post("/routes/plan", json=plan, headers=tunnel).status_code == 403  # ORS quota too
    assert client.put("/routes/active", json={"id": None}, headers=tunnel).status_code == 403
    assert client.get("/routes", headers=tunnel).status_code == 200


def test_plan_without_key_is_a_clear_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ors, "get_secret", lambda name: None)
    with make_client(tmp_path) as c:
        r = c.post("/routes/plan", json={"waypoints": [[56.95, 24.1], [56.952, 24.1]]}, headers=H)
    assert r.status_code == 502 and "ORS_API_KEY" in r.json()["detail"]


async def test_walking_advances_the_active_route_across_sessions(tmp_path: Path, clock: VirtualClock) -> None:
    store = Store(tmp_path / "w.sqlite")
    route = store.add_route("Long", "gpx", LINE, 222.4, now=0)
    store.set_active_route(route["id"])
    fake = FakeBackend(clock=clock, seed=1)
    service = BridgeService(fake, Config(storage=StorageConfig(min_session_s=0)), store,
                            protocol_name="fake", clock=clock, wall_clock=lambda: 1_790_000_000 + clock.t)
    await service.start()
    await run_until(lambda: service.controller is not None)
    service.client_connected("page")

    async def walk(seconds: float) -> None:
        await service.control_start("page", 3.6)
        await run_until(lambda: fake.speed_kmh == 3.6, max_yields=100_000)
        t0 = clock.t
        await run_until(lambda: clock.t > t0 + seconds, max_yields=200_000)
        await service.control_stop("page")
        await run_until(lambda: fake.belt_state is BeltState.STOPPED and service.recorder.session_id is None,
                        max_yields=100_000)

    await walk(60)
    first = store.active_route()["progress_m"]
    assert 60 < first < 100  # ~1 m/s plus the ramp
    await walk(60)  # a second session continues the route
    second = store.active_route()["progress_m"]
    assert second > first + 55
    assert service.status()["route"]["progress_m"] == second
    await walk(120)
    done = store.active_route()
    assert done["progress_m"] == pytest.approx(222.4) and done["completed_at"] is not None
    await service.close()


def test_trails(client: TestClient) -> None:
    body = {"name": "Whisperwood Way", "length_m": 5000, "seed": 42}
    r = client.post("/routes/trail", json=body, headers=H)
    assert r.status_code == 201
    trail = r.json()
    got = (trail["source"], trail["seed"], trail["distance_m"], trail["progress_m"])
    assert got == ("trail", 42, 5000, 0)
    random_seed = client.post("/routes/trail", json={"name": "Somewhere", "length_m": 1200}, headers=H).json()
    assert isinstance(random_seed["seed"], int)
    assert client.get(f"/routes/{trail['id']}").json()["points"] == []
    assert client.post("/routes/trail", json={"name": "x", "length_m": 5}, headers=H).status_code == 422
    assert client.put("/routes/active", json={"id": trail["id"]}, headers=H).status_code == 200
    route = client.get("/status").json()["route"]
    assert (route["source"], route["seed"], route["distance_m"]) == ("trail", 42, 5000)
    tunnel = {**H, "Cf-Connecting-Ip": "8.8.8.8"}
    r = client.post("/routes/trail", json={"name": "x", "length_m": 500}, headers=tunnel)
    assert r.status_code == 403


def test_trail_start_biome_and_regenerate(client: TestClient) -> None:
    body = {"name": "Castle Road", "length_m": 8000, "seed": 5, "start_biome": "castle"}
    trail = client.post("/routes/trail", json=body, headers=H).json()
    assert (trail["seed"], trail["start_biome"]) == (5, "castle")
    plain = client.post("/routes/trail", json={"name": "Plain", "length_m": 800}, headers=H).json()
    assert plain["start_biome"] is None  # the forest, as before
    bad = {"name": "x", "length_m": 800, "start_biome": "city"}
    assert client.post("/routes/trail", json=bad, headers=H).status_code == 422
    # Regenerate: a new seed and starting biome; name and progress stay.
    client.patch(f"/routes/{trail['id']}", json={"progress_m": 1200}, headers=H)
    client.put("/routes/active", json={"id": trail["id"]}, headers=H)
    r = client.patch(f"/routes/{trail['id']}", json={"seed": 99, "start_biome": "falls"}, headers=H)
    assert r.status_code == 200
    got = r.json()
    assert (got["seed"], got["start_biome"], got["name"], got["progress_m"]) == (99, "falls", "Castle Road", 1200)
    route = client.get("/status").json()["route"]
    assert (route["seed"], route["start_biome"]) == (99, "falls")
    patch = client.patch(f"/routes/{trail['id']}", json={"seed": -1}, headers=H)
    assert patch.status_code == 422
    tunnel = {**H, "Cf-Connecting-Ip": "8.8.8.8"}
    assert client.patch(f"/routes/{trail['id']}", json={"seed": 3}, headers=tunnel).status_code == 403


def test_v4_database_gains_the_new_columns(tmp_path: Path) -> None:
    import sqlite3

    path = tmp_path / "v4.sqlite"
    db = sqlite3.connect(path)
    db.executescript(
        "CREATE TABLE routes (id INTEGER PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL,"
        " points TEXT NOT NULL, distance_m REAL NOT NULL, progress_m REAL NOT NULL DEFAULT 0,"
        " active INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, last_walked_at REAL,"
        " completed_at REAL);"
        "INSERT INTO routes (name, source, points, distance_m, created_at)"
        " VALUES ('Old', 'gpx', '[]', 10, 1);"
        "PRAGMA user_version = 4;"
    )
    db.close()
    store = Store(path)
    (old,) = store.list_routes()
    assert old["name"] == "Old" and old["seed"] is None
    trail = store.add_route("New", "trail", [], 500, now=2, seed=7, start_biome="ruins")
    assert (trail["seed"], trail["start_biome"]) == (7, "ruins")
    assert old["start_biome"] is None
