"""Who may control the belt: localhost/LAN only, never through the Cloudflare Tunnel (CLAUDE.md).

The tunnel's `cloudflared` connects to the bridge from localhost, so tunnel traffic looks local
by address. What gives it away is the headers Cloudflare (or any reverse proxy) adds, so any
forwarding header makes a request remote. A LAN client could add such a header itself, but that
only takes rights away from it.

Control requests must also carry a Host that names this machine (an IP address, localhost, this
machine's hostname, or `control_hosts` from config). That stops DNS rebinding, where a web page
from another site re-points its own hostname at the LAN address of this laptop.

Every request and WebSocket that carries an `Origin` header (browsers add it) must also come from
the app's own sites (`app_origins` in config) or from a page on this machine or the LAN
(`origin_allowed`): another website open in the owner's browser can neither read live data nor
open the WebSocket. Requests without an Origin (curl, the page's own same-origin GETs) pass.
"""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Iterable, Mapping

FORWARDING_HEADERS = (
    "cf-connecting-ip",
    "cf-ray",
    "cf-access-jwt-assertion",
    "cf-access-authenticated-user-email",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-real-ip",
    "forwarded",
)


def is_local_client(host: str | None, headers: Mapping[str, str]) -> bool:
    """True for a direct request from this machine or the LAN (private/link-local address)."""
    if any(name in headers for name in FORWARDING_HEADERS):
        return False
    if not host:
        return False
    try:
        ip = ipaddress.ip_address(host.split("%")[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_loopback or ip.is_private or ip.is_link_local


def _host_name(host_header: str) -> str:
    host = host_header.strip().lower()
    if host.startswith("["):  # [::1]:8080
        return host[1 : host.find("]")]
    if host.count(":") == 1:
        host = host.split(":")[0]
    return host.rstrip(".")


def host_is_this_machine(host_header: str | None, extra: Iterable[str] = ()) -> bool:
    if not host_header:
        return False
    host = _host_name(host_header)
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    me = socket.gethostname().lower()
    allowed = {"localhost", me, f"{me}.local", f"{me}.lan", *(h.lower() for h in extra)}
    return host in allowed


def control_refusal(
    client_host: str | None,
    headers: Mapping[str, str],
    *,
    allow_remote: bool,
    extra_hosts: Iterable[str] = (),
) -> str | None:
    """None if this request may control the belt, else the reason it may not."""
    if not host_is_this_machine(headers.get("host"), extra_hosts):
        return "control requests must address this machine by IP or hostname"
    if allow_remote:
        return None
    if not is_local_client(client_host, headers):
        return "belt control is only accepted from localhost/LAN (remote access is read-only)"
    return None


def _private_or_this_machine(host: str, extra: Iterable[str]) -> bool:
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        me = socket.gethostname().lower()
        return host in {"localhost", me, f"{me}.local", f"{me}.lan", *(h.lower() for h in extra)}
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_loopback or ip.is_private or ip.is_link_local


def origin_allowed(origin: str | None, app_origins: Iterable[str], extra_hosts: Iterable[str] = ()) -> bool:
    """Whether a browser page from `origin` may talk to the bridge at all (None: not a browser
    cross-site request, allowed). Allowed: the app's own origins (exact match), and pages served
    from localhost, a LAN address or this machine's name, on any port (the bridge itself, the
    Vite dev server)."""
    if origin is None or origin == "":
        return True
    origin = origin.strip().lower().rstrip("/")
    if origin in {o.strip().lower().rstrip("/") for o in app_origins}:
        return True
    scheme, sep, rest = origin.partition("://")
    if not sep or scheme not in ("http", "https") or not rest:
        return False  # "null" (sandboxed or file pages) and anything odd
    return _private_or_this_machine(_host_name(rest), extra_hosts)
