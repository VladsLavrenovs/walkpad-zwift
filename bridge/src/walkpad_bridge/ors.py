"""OpenRouteService walking directions, called by the bridge (the key never leaves it).

Uses the stdlib HTTP client in a worker thread; one request per plan.
"""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass

from .routes import Point, clean_points, route_length_m
from .secrets import get_secret

ORS_URL = "https://api.openrouteservice.org/v2/directions/foot-walking/geojson"
TIMEOUT_S = 20.0


class OrsError(Exception):
    """ORS could not plan the route (bad input, quota, network). Message is safe to show."""


@dataclass(frozen=True, slots=True)
class PlannedRoute:
    points: list[Point]
    distance_m: float


# (url, body, headers) -> (status, response body). Tests substitute this.
Transport = Callable[[str, bytes, dict[str, str]], tuple[int, bytes]]


def _urllib_transport(url: str, body: bytes, headers: dict[str, str]) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except (urllib.error.URLError, TimeoutError) as exc:
        raise OrsError(f"cannot reach OpenRouteService: {getattr(exc, 'reason', exc)}") from exc


def _error_message(status: int, body: bytes, key: str) -> str:
    try:
        err = json.loads(body).get("error")
        message = err.get("message") if isinstance(err, dict) else err
    except (ValueError, AttributeError):
        message = None
    hints = {401: "the ORS key is wrong", 403: "the ORS key is not allowed to do this",
             429: "ORS quota or rate limit reached; try later"}
    text = hints.get(status) or str(message or f"HTTP {status}")
    return text.replace(key, "***")  # never echo the key


async def plan_walk(
    waypoints: list[Point], transport: Transport = _urllib_transport, key: str | None = None
) -> PlannedRoute:
    key = key or get_secret("ORS_API_KEY")
    if not key:
        raise OrsError("route planning is not set up: ORS_API_KEY is missing on the bridge")
    body = json.dumps({"coordinates": [[lon, lat] for lat, lon in waypoints]}).encode()
    headers = {"Authorization": key, "Content-Type": "application/json",
               "Accept": "application/geo+json", "User-Agent": "walkpad-bridge"}
    status, raw = await asyncio.to_thread(transport, ORS_URL, body, headers)
    if status != 200:
        raise OrsError(f"OpenRouteService: {_error_message(status, raw, key)}")
    try:
        feature = json.loads(raw)["features"][0]
        coords = feature["geometry"]["coordinates"]
        points = clean_points((float(lat), float(lon)) for lon, lat, *_ in coords)
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise OrsError(f"unexpected answer from OpenRouteService: {exc}") from exc
    return PlannedRoute(points, route_length_m(points))
