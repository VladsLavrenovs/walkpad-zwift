"""Routes: GPX import, geometry, and progress along the active route.

A route is a polyline of (lat, lon) points. Walking on the pad moves you along the active route:
the service feeds every sample's session distance to `RouteProgress`, which adds what was walked
to the route's stored progress. Progress lives in the database, so a long route can take many
walks, and no page has to be open for it to count.
"""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from .storage import Store

EARTH_RADIUS_M = 6_371_000.0
MAX_POINTS = 20_000
MIN_SPACING_M = 1.0  # points closer than this add nothing but size

Point = tuple[float, float]  # (lat, lon)


def haversine_m(a: Point, b: Point) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(min(1.0, h)))


def route_length_m(points: list[Point]) -> float:
    return sum(haversine_m(a, b) for a, b in zip(points, points[1:]))


def clean_points(points: Iterable[Point]) -> list[Point]:
    """Validate, round to ~10 cm, drop near-duplicates. Raises ValueError if unusable."""
    out: list[Point] = []
    for lat, lon in points:
        if not (math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError(f"invalid coordinate ({lat}, {lon})")
        p = (round(lat, 6), round(lon, 6))
        if out and haversine_m(out[-1], p) < MIN_SPACING_M:
            continue
        out.append(p)
    if len(out) < 2:
        raise ValueError("a route needs at least two distinct points")
    if len(out) > MAX_POINTS:
        raise ValueError(f"route has {len(out)} points; at most {MAX_POINTS}")
    return out


@dataclass(frozen=True, slots=True)
class ParsedGpx:
    name: str
    points: list[Point]


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]  # drop the GPX 1.0 / 1.1 namespace


def parse_gpx(data: bytes) -> ParsedGpx:
    """Track points (or else route points) of a GPX file, in order, all segments joined."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise ValueError(f"not valid XML: {exc}") from exc
    if _local(root.tag) != "gpx":
        raise ValueError("not a GPX file")
    by_kind: dict[str, list[Point]] = {"trkpt": [], "rtept": []}
    name = ""
    for el in root.iter():
        tag = _local(el.tag)
        if tag in by_kind:
            try:
                by_kind[tag].append((float(el.attrib["lat"]), float(el.attrib["lon"])))
            except (KeyError, ValueError) as exc:
                raise ValueError("a point has no valid lat/lon") from exc
        elif tag == "name" and not name and el.text:
            name = el.text.strip()
    points = by_kind["trkpt"] or by_kind["rtept"]
    if not points:
        raise ValueError("the GPX file has no track or route points")
    return ParsedGpx(name[:200], clean_points(points))


class RouteProgress:
    """Adds walked distance to the active route.

    Fed with (session id, session distance) on every sample. Only increases within one session
    count, so switching routes mid-walk, restarting the bridge or a pad counter reset never
    moves a route backwards or double-counts.
    """

    def __init__(self, store: Store, wall_clock: Callable[[], float]) -> None:
        self.store = store
        self.wall_clock = wall_clock
        self._session: int | None = None
        self._last_m = 0.0

    def on_distance(self, session_id: int | None, distance_m: float) -> dict | None:
        """Returns the active route (with updated progress) if it moved, else None."""
        if session_id is None:
            self._session = None
            return None
        if session_id != self._session:
            self._session = session_id
            self._last_m = distance_m
            return None
        delta = distance_m - self._last_m
        self._last_m = max(self._last_m, distance_m)
        if delta <= 0:
            return None
        return self.store.advance_active_route(delta, self.wall_clock())
