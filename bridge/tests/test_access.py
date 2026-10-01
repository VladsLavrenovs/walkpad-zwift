import socket

import pytest

from walkpad_bridge.access import control_refusal, host_is_this_machine, is_local_client, origin_allowed


@pytest.mark.parametrize(
    ("host", "local"),
    [
        ("127.0.0.1", True), ("::1", True), ("192.168.1.20", True), ("10.0.0.5", True),
        ("172.16.3.4", True), ("fe80::1%eth0", True), ("::ffff:192.168.1.20", True),
        ("8.8.8.8", False), ("100.64.1.1", False),  # CGNAT / Tailscale: not LAN
        ("2a00:1450::1", False), ("testclient", False), (None, False),
    ],
)
def test_is_local_client(host: str | None, local: bool) -> None:
    assert is_local_client(host, {}) is local


@pytest.mark.parametrize("header", ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "forwarded"])
def test_tunnel_traffic_is_remote_even_from_localhost(header: str) -> None:
    # cloudflared connects from 127.0.0.1; its headers give it away.
    assert is_local_client("127.0.0.1", {header: "1.2.3.4"}) is False


@pytest.mark.parametrize(
    ("host", "ok"),
    [
        ("192.168.1.20:8080", True), ("127.0.0.1", True), ("[::1]:8080", True),
        ("localhost:8080", True), (f"{socket.gethostname()}.local:8080", True),
        (socket.gethostname().upper(), True), ("pad.home", True),  # from control_hosts
        ("evil.example:8080", False), ("walkpad-bridge.connectedovals.com", False), (None, False),
    ],
)
def test_host_is_this_machine(host: str | None, ok: bool) -> None:
    assert host_is_this_machine(host, ["pad.home"]) is ok


def test_control_refusal() -> None:
    lan = {"host": "192.168.1.20:8080"}
    assert control_refusal("192.168.1.30", lan, allow_remote=False) is None
    assert "localhost/LAN" in control_refusal("8.8.8.8", lan, allow_remote=False)
    tunnel = {"host": "localhost:8080", "cf-connecting-ip": "8.8.8.8"}
    assert "localhost/LAN" in control_refusal("127.0.0.1", tunnel, allow_remote=False)
    assert control_refusal("127.0.0.1", tunnel, allow_remote=True) is None  # explicit opt-in
    rebinding = {"host": "evil.example"}
    assert "address this machine" in control_refusal("192.168.1.30", rebinding, allow_remote=True)


APP = ("https://walk.connectedovals.com", "https://walkpad-bridge.connectedovals.com")


@pytest.mark.parametrize(
    ("origin", "ok"),
    [
        (None, True), ("", True),
        ("https://walk.connectedovals.com", True), ("https://WALK.connectedovals.com/", True),
        ("http://127.0.0.1:8080", True), ("http://[::1]:5173", True), ("http://10.0.0.7:8080", True),
        (f"http://{socket.gethostname()}.local:8080", True), ("http://pad.home:8080", True),
        ("https://evil.example", False), ("http://8.8.8.8:8080", False), ("null", False),
        ("file://", False), ("https://connectedovals.com", False),
    ],
)
def test_origin_allowed(origin: str | None, ok: bool) -> None:
    assert origin_allowed(origin, APP, ["pad.home"]) is ok
