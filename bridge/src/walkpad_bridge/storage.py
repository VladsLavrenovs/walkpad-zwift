"""SQLite storage: walking sessions and their per-second samples (stdlib sqlite3).

Session totals are updated with every stored sample, so a crash or power cut leaves a session
with correct totals; it is closed (ended_at = its last sample) on the next start.
"""

from __future__ import annotations

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
"""
SCHEMA_VERSION = 1


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

    def finished_sessions(self) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT * FROM sessions WHERE ended_at IS NOT NULL ORDER BY started_at")
        return [_session(r) for r in rows]


def _session(row: sqlite3.Row) -> dict[str, Any]:
    session = dict(row)
    duration = session["duration_s"]
    session["avg_speed_kmh"] = round(session["distance_m"] / duration * 3.6, 2) if duration > 0 else 0.0
    return session

