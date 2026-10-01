"""The FastAPI app over a FAKE pad (scaled real time): read-only API, live WebSocket, control."""

from __future__ import annotations

import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from walkpad_bridge.clock import ScaledClock
from walkpad_bridge.config import Config, ServerConfig, StorageConfig
from walkpad_bridge.fake import FakeBackend
from walkpad_bridge.server import create_app
from walkpad_bridge.service import BridgeService
from walkpad_bridge.storage import Store

LAN = ("192.168.1.30", 50000)
H = {"X-Client-Id": "page"}


def make_client(tmp_path: Path, peer: tuple[str, int] = LAN, web_dist: Path | None = None,
                **server: object) -> TestClient:
    clock = ScaledClock(50)
    fake = FakeBackend(clock=clock, seed=1)
    cfg = Config(
        server=ServerConfig(web_dist=str(web_dist or tmp_path / "no-dist"), **server),  # type: ignore[arg-type]
        storage=StorageConfig(min_session_s=0),
    )
    service = BridgeService(fake, cfg, Store(tmp_path / "w.sqlite"), protocol_name="fake", clock=clock)
    return TestClient(create_app(service, cfg), base_url="http://192.168.1.20:8080", client=peer)


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with make_client(tmp_path) as c:
        yield c


def wait_for(c: TestClient, pred, timeout: float = 5.0) -> dict:  # type: ignore[no-untyped-def]
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = c.get("/status").json()
        if pred(status):
            return status
        time.sleep(0.02)
    raise AssertionError(f"timed out; last status {status}")


def test_status_and_placeholder_page(client: TestClient) -> None:
    status = wait_for(client, lambda s: s["connected"])
    assert status["belt"] == "stopped" and status["control_allowed"] is True
    assert "web app is not built" in client.get("/").text


def test_walk_through_the_api(client: TestClient) -> None:
    with client.websocket_connect("/live?client=page") as ws:
        assert ws.receive_json()["type"] == "status"
        r = client.post("/control/start", json={"kmh": 9}, headers=H)
        assert r.status_code == 200
        assert r.json()["applied_target_kmh"] == 6.0  # after the cap, not the request
        wait_for(client, lambda s: s["speed_kmh"] == 6.0, timeout=10)
        r = client.post("/control/speed", json={"kmh": 4.5}, headers=H)
        assert r.json()["applied_target_kmh"] == 4.5
        samples = [m for m in (ws.receive_json() for _ in range(5)) if m["type"] == "sample"]
        assert samples and samples[-1]["session_id"] is not None
        assert client.post("/control/stop", headers=H).status_code == 200
        wait_for(client, lambda s: s["belt"] == "stopped" and s["session_id"] is None, timeout=10)
    sessions = client.get("/sessions").json()
    assert sessions["total"] == 1
    sid = sessions["sessions"][0]["id"]
    detail = client.get(f"/sessions/{sid}").json()
    assert detail["max_speed_kmh"] == 6.0 and detail["samples"]
    assert client.get("/sessions/999").status_code == 404
    stats = client.get("/stats").json()
    assert stats["daily"][-1]["sessions"] == 1
    assert set(stats) >= {"daily", "weekly", "monthly", "streaks", "personal_bests"}


def test_control_needs_client_id_and_live_socket(client: TestClient) -> None:
    wait_for(client, lambda s: s["connected"])
    assert client.post("/control/start", json={"kmh": 2}).status_code == 422  # no X-Client-Id
    assert client.post("/control/start", json={"kmh": 2}, headers={"X-Client-Id": "a b"}).status_code == 422
    r = client.post("/control/start", json={"kmh": 2}, headers=H)
    assert r.status_code == 409 and "WebSocket" in r.json()["detail"]
    for bad in (0, -1):
        assert client.post("/control/speed", json={"kmh": bad}, headers=H).status_code == 422


@pytest.mark.parametrize(
    ("peer", "headers"),
    [
        (("8.8.8.8", 1), {}),  # internet
        (("127.0.0.1", 1), {"Cf-Connecting-Ip": "8.8.8.8"}),  # Cloudflare Tunnel
        (("127.0.0.1", 1), {"X-Forwarded-For": "8.8.8.8"}),  # any proxy
        (LAN, {"Host": "evil.example"}),  # DNS rebinding
    ],
)
def test_remote_and_rebinding_requests_cannot_control(
    tmp_path: Path, peer: tuple[str, int], headers: dict[str, str]
) -> None:
    with make_client(tmp_path, peer=peer) as c:
        with c.websocket_connect("/live?client=page", headers=headers):
            for path in ("/control/start", "/control/speed", "/control/stop"):
                r = c.post(path, json={"kmh": 2}, headers={**H, **headers})
                assert r.status_code == 403, (path, r.text)
            status = c.get("/status", headers=headers).json()
            assert status["control_allowed"] is False
            assert c.get("/sessions", headers=headers).status_code == 200  # reading is fine


def test_remote_control_can_be_enabled_explicitly(tmp_path: Path) -> None:
    with make_client(tmp_path, peer=("8.8.8.8", 1), allow_remote_control=True) as c:
        assert c.get("/status").json()["control_allowed"] is True


def test_remote_websocket_does_not_count_as_a_controlling_client(tmp_path: Path) -> None:
    # A remote viewer using the same client id must not keep a local page's control alive.
    with make_client(tmp_path, peer=("8.8.8.8", 1), allow_remote_control=True) as c:
        with c.websocket_connect("/live?client=page"):
            r = c.post("/control/start", json={"kmh": 2}, headers=H)
            assert r.status_code == 409


def test_cross_origin_pages_may_read_but_not_control(client: TestClient) -> None:
    allowed = client.get("/stats", headers={"Origin": "https://walk.connectedovals.com"})
    assert allowed.headers["access-control-allow-origin"] == "https://walk.connectedovals.com"
    preflight = client.options("/control/stop", headers={
        "Origin": "https://walk.connectedovals.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-client-id",
    })
    assert preflight.status_code == 400  # the browser will not send the POST
    evil = client.get("/stats", headers={"Origin": "https://evil.example"})
    assert evil.status_code == 403
    assert allowed.headers["access-control-allow-credentials"] == "true"  # the Access cookie


@pytest.mark.parametrize(
    ("origin", "ok"),
    [
        (None, True),  # curl, same-origin GETs
        ("https://walk.connectedovals.com", True),
        ("https://walkpad-bridge.connectedovals.com", True),
        ("http://192.168.1.20:8080", True),  # the page the bridge serves on the LAN
        ("http://localhost:5173", True),  # the Vite dev server
        ("https://evil.example", False),
        ("http://walk.connectedovals.com", False),  # wrong scheme
        ("https://walk.connectedovals.com.evil.example", False),
        ("null", False),
    ],
)
def test_requests_from_other_websites_are_refused(client: TestClient, origin: str | None, ok: bool) -> None:
    headers = {} if origin is None else {"Origin": origin}
    assert (client.get("/status", headers=headers).status_code == 200) is ok
    if ok:
        with client.websocket_connect("/live", headers=headers) as ws:
            assert "connected" in ws.receive_json()  # the first status message
    else:
        with pytest.raises(WebSocketDisconnect) as refused:
            with client.websocket_connect("/live", headers=headers):
                pass
        assert refused.value.code == 1008
        # Control from another site is refused before the control checks run.
        assert client.post("/control/stop", headers={**H, "Origin": origin}).status_code == 403


def test_serves_the_built_web_app(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<h1>WalkPad</h1>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    with make_client(tmp_path, web_dist=dist) as c:
        assert c.get("/").text == "<h1>WalkPad</h1>"
        assert c.get("/assets/app.js").text == "console.log(1)"
        assert c.get("/status").json()["type"] == "status"  # API routes still win


def test_web_app_built_after_start_is_served_without_restart(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    with make_client(tmp_path, web_dist=dist) as c:
        assert "web app is not built" in c.get("/").text
        dist.mkdir()
        (dist / "index.html").write_text("<h1>WalkPad</h1>")
        assert c.get("/").text == "<h1>WalkPad</h1>"
        assert c.get("/sessions").status_code == 200
