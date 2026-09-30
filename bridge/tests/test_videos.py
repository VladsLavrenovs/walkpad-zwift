"""Video library: URL parsing, storage (incl. the v1 -> v2 upgrade) and the API."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from test_server import H, LAN, make_client
from walkpad_bridge.storage import Store
from walkpad_bridge.youtube import parse_youtube_url

ID = "aBcDeFgHiJ1"


@pytest.mark.parametrize(
    ("url", "start"),
    [
        (f"https://www.youtube.com/watch?v={ID}", 0),
        (f"https://youtube.com/watch?v={ID}&list=PL123&t=95", 95),
        (f"https://m.youtube.com/watch?v={ID}&t=1h2m3s", 3723),
        (f"https://youtu.be/{ID}?t=30", 30),
        (f"https://www.youtube.com/shorts/{ID}", 0),
        (f"https://www.youtube.com/embed/{ID}?start=12", 12),
        (f"https://www.youtube.com/live/{ID}", 0),
        (f"youtube.com/watch?v={ID}", 0),
        (ID, 0),
    ],
)
def test_parse_youtube_url(url: str, start: float) -> None:
    ref = parse_youtube_url(url)
    assert (ref.video_id, ref.start_s) == (ID, start)


@pytest.mark.parametrize(
    "url",
    ["https://vimeo.com/123", "https://www.youtube.com/watch?v=short", "https://evil.com/watch?v=" + ID,
     "https://www.youtube.com/channel/UCxyz", "not a url at all"],
)
def test_rejects_other_links(url: str) -> None:
    with pytest.raises(ValueError):
        parse_youtube_url(url)


def test_v1_database_gains_the_video_table_and_keeps_sessions(tmp_path: Path) -> None:
    path = tmp_path / "old.sqlite"
    db = sqlite3.connect(path)
    db.executescript(
        "CREATE TABLE sessions (id INTEGER PRIMARY KEY, started_at REAL NOT NULL, ended_at REAL,"
        " duration_s REAL NOT NULL DEFAULT 0, distance_m REAL NOT NULL DEFAULT 0, steps INTEGER,"
        " max_speed_kmh REAL NOT NULL DEFAULT 0, protocol TEXT);"
        "INSERT INTO sessions (started_at, ended_at, duration_s, distance_m) VALUES (1, 61, 60, 50);"
        "PRAGMA user_version = 1;"
    )
    db.close()
    store = Store(path)
    assert store.count_sessions() == 1
    assert store.list_videos() == []
    assert store.db.execute("PRAGMA user_version").fetchone()[0] == 2


def test_store_videos(tmp_path: Path) -> None:
    store = Store(tmp_path / "w.sqlite")
    a, created = store.add_video(ID, "u", "", 4.5, 0, now=10)
    assert created and a["pace_kmh"] == 4.5 and a["last_played_at"] is None
    again, created = store.add_video(ID, "other url", "x", 3.0, 0, now=11)
    assert not created and again["id"] == a["id"]  # same video: not added twice
    b, _ = store.add_video("zzzzzzzzzzz", "u2", "B", 4.0, 0, now=12)
    assert [v["id"] for v in store.list_videos()] == [b["id"], a["id"]]  # newest first
    store.update_video(a["id"], {"position_s": 321.5}, now=20)
    assert [v["id"] for v in store.list_videos()] == [a["id"], b["id"]]  # last played first
    updated = store.update_video(a["id"], {"pace_kmh": 5.0, "title": "Kyoto", "id": 99}, now=21)
    assert updated is not None
    got = (updated["id"], updated["pace_kmh"], updated["title"], updated["position_s"])
    assert got == (a["id"], 5.0, "Kyoto", 321.5)
    assert store.delete_video(a["id"]) and not store.delete_video(a["id"])


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with make_client(tmp_path) as c:
        yield c


def test_video_api(client: TestClient) -> None:
    r = client.post("/videos", json={"url": f"https://youtu.be/{ID}?t=60"}, headers=H)
    assert r.status_code == 201
    v = r.json()
    assert (v["video_id"], v["position_s"], v["pace_kmh"]) == (ID, 60, 4.5)
    assert client.post("/videos", json={"url": ID}, headers=H).status_code == 200  # already there
    assert client.post("/videos", json={"url": "https://vimeo.com/1"}, headers=H).status_code == 422
    assert client.post("/videos", json={"url": ID, "pace_kmh": 20}, headers=H).status_code == 422

    change = {"pace_kmh": 3.8, "position_s": 125.5, "title": " Tokyo "}
    r = client.patch(f"/videos/{v['id']}", json=change, headers=H)
    assert r.status_code == 200
    assert (r.json()["pace_kmh"], r.json()["position_s"], r.json()["title"]) == (3.8, 125.5, "Tokyo")
    assert r.json()["last_played_at"] is not None
    assert client.patch("/videos/999", json={"pace_kmh": 4}, headers=H).status_code == 404

    assert client.get("/videos").json()["videos"][0]["title"] == "Tokyo"
    assert client.delete(f"/videos/{v['id']}", headers=H).status_code == 204
    assert client.get("/videos").json()["videos"] == []


def test_video_library_is_read_only_from_outside(tmp_path: Path) -> None:
    tunnel = {"Cf-Connecting-Ip": "8.8.8.8"}
    with make_client(tmp_path, peer=("127.0.0.1", 1)) as c:
        assert c.post("/videos", json={"url": ID}, headers={**H, **tunnel}).status_code == 403
        assert c.post("/videos", json={"url": ID}).status_code == 422  # no X-Client-Id
        assert c.get("/videos", headers=tunnel).status_code == 200


def test_video_writes_need_no_live_socket(tmp_path: Path) -> None:
    with make_client(tmp_path, peer=LAN) as c:
        assert c.post("/videos", json={"url": ID}, headers=H).status_code == 201
