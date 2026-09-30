"""SQLite storage: walking sessions and their per-second samples, the video library, and
routes with their progress (stdlib sqlite3).

Session totals are updated with every stored sample, so a crash or power cut leaves a session
with correct totals; it is closed (ended_at = its last sample) on the next start.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .backend import Sample

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id            INTEGER PRIMARY KEY,
    started_at    REAL NOT NULL,           -- unix time
    ended_at      REAL,                    -- NULL while the belt is running
    duration_s    REAL NOT NULL DEFAULT 0, -- walking time as counted by the pad
    distance_m    REAL NOT NULL DEFAULT 0,
    steps         INTEGER,                 -- NULL if the pad has no step count (FTMS)
    max_speed_kmh REAL NOT NULL DEFAULT 0,
    protocol      TEXT                     -- kingsmith | ftms | fake
);
CREATE INDEX IF NOT EXISTS sessions_started_at ON sessions (started_at);

CREATE TABLE IF NOT EXISTS samples (
    session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    t          REAL NOT NULL,              -- unix time
    speed_kmh  REAL NOT NULL,
    distance_m REAL NOT NULL,              -- session totals so far (not the pad's raw counters)
    steps      INTEGER,
    elapsed_s  REAL NOT NULL,
    belt       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS samples_session_t ON samples (session_id, t);

-- v2: walking-tour videos for the YouTube world. Scenery only; sessions do not refer to them.
CREATE TABLE IF NOT EXISTS videos (
    id             INTEGER PRIMARY KEY,
    video_id       TEXT NOT NULL UNIQUE,   -- YouTube id (11 chars)
    url            TEXT NOT NULL,          -- as pasted
    title          TEXT NOT NULL DEFAULT '',
    pace_kmh       REAL NOT NULL DEFAULT 4.5, -- walking pace of whoever filmed it
    position_s     REAL NOT NULL DEFAULT 0,   -- where playback last stopped
    created_at     REAL NOT NULL,
    last_played_at REAL
);

-- v3: routes (GPX imports and planned walks). Progress persists across sessions.
CREATE TABLE IF NOT EXISTS routes (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL,
    source         TEXT NOT NULL,          -- gpx | ors
    points         TEXT NOT NULL,          -- JSON [[lat, lon], ...]
    distance_m     REAL NOT NULL,
    progress_m     REAL NOT NULL DEFAULT 0,
    active         INTEGER NOT NULL DEFAULT 0, -- at most one route is active
    created_at     REAL NOT NULL,
    last_walked_at REAL,
    completed_at   REAL
);
"""
# v1 -> v2 -> v3 only add tables, which CREATE ... IF NOT EXISTS does on open.
SCHEMA_VERSION = 3
DEFAULT_PACE_KMH = 4.5
VIDEO_FIELDS = ("title", "pace_kmh", "position_s")


@dataclass(frozen=True, slots=True)
class Totals:
    duration_s: float = 0.0
    distance_m: float = 0.0
    steps: int | None = None
    max_speed_kmh: float = 0.0


class Store:
    def __init__(self, path: Path | str) -> None:
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        # Autocommit, one connection. All access happens on the event loop's thread; the check
        # is off only because the loop may run on a different thread than the one that opened
        # the store (test clients do that).
        self.db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.execute("PRAGMA journal_mode = WAL")
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version > SCHEMA_VERSION:
            raise RuntimeError(f"database schema v{version} is newer than this bridge (v{SCHEMA_VERSION})")
        self.db.executescript(SCHEMA)
        self.db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def close(self) -> None:
        self.db.close()

    # --- writes ---------------------------------------------------------------------------

    def open_session(self, started_at: float, protocol: str | None) -> int:
        cur = self.db.execute(
            "INSERT INTO sessions (started_at, protocol) VALUES (?, ?)", (started_at, protocol)
        )
        assert cur.lastrowid is not None
        return cur.lastrowid

    def add_sample(self, session_id: int, t: float, sample: Sample, totals: Totals) -> None:
        with self.db:  # one transaction for the sample and the totals
            self.db.execute("BEGIN")
            self.db.execute(
                "INSERT INTO samples (session_id, t, speed_kmh, distance_m, steps, elapsed_s, belt)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (session_id, t, sample.speed_kmh, totals.distance_m, totals.steps,
                 totals.duration_s, str(sample.belt)),
            )
            self._write_totals(session_id, totals)

    def close_session(self, session_id: int, ended_at: float, totals: Totals) -> None:
        with self.db:
            self.db.execute("BEGIN")
            self._write_totals(session_id, totals)
            self.db.execute("UPDATE sessions SET ended_at = ? WHERE id = ?", (ended_at, session_id))

    def reopen_session(self, session_id: int) -> None:
        self.db.execute("UPDATE sessions SET ended_at = NULL WHERE id = ?", (session_id,))

    def delete_session(self, session_id: int) -> None:
        self.db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))

    def close_dangling(self, min_session_s: float) -> int:
        """Close sessions left open by a crash: ended_at = last sample. Returns how many."""
        rows = self.db.execute("SELECT id, started_at, duration_s FROM sessions WHERE ended_at IS NULL")
        closed = 0
        for row in rows.fetchall():
            last = self.db.execute(
                "SELECT MAX(t) FROM samples WHERE session_id = ?", (row["id"],)
            ).fetchone()[0]
            if row["duration_s"] < min_session_s:
                self.delete_session(row["id"])
            else:
                self.db.execute(
                    "UPDATE sessions SET ended_at = ? WHERE id = ?",
                    (last if last is not None else row["started_at"], row["id"]),
                )
            closed += 1
        return closed

    def _write_totals(self, session_id: int, totals: Totals) -> None:
        self.db.execute(
            "UPDATE sessions SET duration_s = ?, distance_m = ?, steps = ?, max_speed_kmh = ?"
            " WHERE id = ?",
            (totals.duration_s, totals.distance_m, totals.steps, totals.max_speed_kmh, session_id),
        )

    # --- reads ----------------------------------------------------------------------------

    def list_sessions(self, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        rows = self.db.execute(
            "SELECT * FROM sessions ORDER BY started_at DESC LIMIT ? OFFSET ?", (limit, offset)
        )
        return [_session(r) for r in rows]

    def count_sessions(self) -> int:
        return self.db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]

    def get_session(self, session_id: int, with_samples: bool = True) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if row is None:
            return None
        session = _session(row)
        if with_samples:
            samples = self.db.execute(
                "SELECT t, speed_kmh, distance_m, steps, elapsed_s, belt FROM samples"
                " WHERE session_id = ? ORDER BY t",
                (session_id,),
            )
            session["samples"] = [dict(s) for s in samples]
        return session

    # --- video library ----------------------------------------------------------------------

    def add_video(
        self, video_id: str, url: str, title: str, pace_kmh: float, position_s: float, now: float
    ) -> tuple[dict[str, Any], bool]:
        """Add a video; if it is already in the library, return that one. (video, created)"""
        existing = self.db.execute("SELECT * FROM videos WHERE video_id = ?", (video_id,)).fetchone()
        if existing is not None:
            return dict(existing), False
        cur = self.db.execute(
            "INSERT INTO videos (video_id, url, title, pace_kmh, position_s, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (video_id, url, title, pace_kmh, position_s, now),
        )
        assert cur.lastrowid is not None
        video = self.get_video(cur.lastrowid)
        assert video is not None
        return video, True

    def list_videos(self) -> list[dict[str, Any]]:
        rows = self.db.execute(
            "SELECT * FROM videos ORDER BY last_played_at IS NULL, last_played_at DESC, created_at DESC"
        )
        return [dict(r) for r in rows]

    def get_video(self, id: int) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM videos WHERE id = ?", (id,)).fetchone()
        return None if row is None else dict(row)

    def update_video(self, id: int, fields: dict[str, Any], now: float) -> dict[str, Any] | None:
        """Update title / pace_kmh / position_s. A new position also marks it last played."""
        changes = {k: v for k, v in fields.items() if k in VIDEO_FIELDS and v is not None}
        if "position_s" in changes:
            changes["last_played_at"] = now
        if changes:
            assignments = ", ".join(f"{k} = ?" for k in changes)
            self.db.execute(f"UPDATE videos SET {assignments} WHERE id = ?", (*changes.values(), id))
        return self.get_video(id)

    def delete_video(self, id: int) -> bool:
        return self.db.execute("DELETE FROM videos WHERE id = ?", (id,)).rowcount > 0

    # --- routes -------------------------------------------------------------------------------

    def add_route(self, name: str, source: str, points: list[tuple[float, float]], distance_m: float,
                  now: float) -> dict[str, Any]:
        cur = self.db.execute(
            "INSERT INTO routes (name, source, points, distance_m, created_at) VALUES (?, ?, ?, ?, ?)",
            (name, source, json.dumps(points, separators=(",", ":")), distance_m, now),
        )
        assert cur.lastrowid is not None
        route = self.get_route(cur.lastrowid, with_points=False)
        assert route is not None
        return route

    def list_routes(self) -> list[dict[str, Any]]:
        rows = self.db.execute(f"SELECT {ROUTE_SUMMARY} FROM routes ORDER BY active DESC, "
                               "last_walked_at IS NULL, last_walked_at DESC, created_at DESC")
        return [_route(r) for r in rows]

    def get_route(self, id: int, with_points: bool = True) -> dict[str, Any] | None:
        cols = "*" if with_points else ROUTE_SUMMARY
        row = self.db.execute(f"SELECT {cols} FROM routes WHERE id = ?", (id,)).fetchone()
        return None if row is None else _route(row)

    def active_route(self) -> dict[str, Any] | None:
        row = self.db.execute(f"SELECT {ROUTE_SUMMARY} FROM routes WHERE active = 1").fetchone()
        return None if row is None else _route(row)

    def set_active_route(self, id: int | None) -> bool:
        """Make `id` the active route (None: no route). False if there is no such route."""
        with self.db:
            self.db.execute("BEGIN")
            exists = self.db.execute("SELECT 1 FROM routes WHERE id = ?", (id,)).fetchone()
            if id is not None and exists is None:
                return False
            self.db.execute("UPDATE routes SET active = 0 WHERE active = 1")
            if id is not None:
                self.db.execute("UPDATE routes SET active = 1 WHERE id = ?", (id,))
        return True

    def update_route(self, id: int, name: str | None, progress_m: float | None) -> dict[str, Any] | None:
        route = self.get_route(id, with_points=False)
        if route is None:
            return None
        if name is not None:
            self.db.execute("UPDATE routes SET name = ? WHERE id = ?", (name, id))
        if progress_m is not None:
            progress = min(max(0.0, progress_m), route["distance_m"])
            completed = route["completed_at"] if progress >= route["distance_m"] else None
            self.db.execute("UPDATE routes SET progress_m = ?, completed_at = ? WHERE id = ?",
                            (progress, completed, id))
        return self.get_route(id, with_points=False)

    def advance_active_route(self, delta_m: float, now: float) -> dict[str, Any] | None:
        """Add walked distance to the active route (stops at its end). The route, or None."""
        route = self.active_route()
        if route is None or route["progress_m"] >= route["distance_m"]:
            return route
        progress = min(route["distance_m"], route["progress_m"] + delta_m)
        completed = now if progress >= route["distance_m"] else None
        self.db.execute(
            "UPDATE routes SET progress_m = ?, last_walked_at = ?, completed_at = COALESCE(completed_at, ?)"
            " WHERE id = ?",
            (progress, now, completed, route["id"]),
        )
        return self.get_route(route["id"], with_points=False)

    def delete_route(self, id: int) -> bool:
        return self.db.execute("DELETE FROM routes WHERE id = ?", (id,)).rowcount > 0

    def finished_sessions(self) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT * FROM sessions WHERE ended_at IS NOT NULL ORDER BY started_at")
        return [_session(r) for r in rows]


ROUTE_SUMMARY = ("id, name, source, distance_m, progress_m, active, created_at, last_walked_at,"
                 " completed_at")


def _route(row: sqlite3.Row) -> dict[str, Any]:
    route = dict(row)
    route["active"] = bool(route["active"])
    if "points" in route:
        route["points"] = json.loads(route["points"])
    return route


def _session(row: sqlite3.Row) -> dict[str, Any]:
    session = dict(row)
    duration = session["duration_s"]
    session["avg_speed_kmh"] = round(session["distance_m"] / duration * 3.6, 2) if duration > 0 else 0.0
    return session

