from pathlib import Path

import pytest

from walkpad_bridge.backend import BeltState, Sample
from walkpad_bridge.recorder import SessionRecorder
from walkpad_bridge.storage import Store

R, STOPPING, STOPPED = BeltState.RUNNING, BeltState.STOPPING, BeltState.STOPPED


class Wall:
    def __init__(self) -> None:
        self.t = 1_000_000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(tmp_path / "w.sqlite")


def feed(rec: SessionRecorder, wall: Wall, rows: list[tuple[float, float, int, float, BeltState]],
         dt: float = 1.0) -> None:
    for kmh, dist, steps, elapsed, belt in rows:
        rec.on_sample(Sample(kmh, dist, steps, elapsed, belt))
        wall.t += dt


def test_real_pad_session_with_counter_reset_while_stopping(store: Store) -> None:
    """Replays the owner's pad: countdown, walk, then time/distance zero while still slowing."""
    wall = Wall()
    rec = SessionRecorder(store, "kingsmith", min_session_s=10, wall_clock=wall)
    feed(rec, wall, [(0.0, 0, 0, 0, STOPPED), (0.0, 0, 0, 0, R)])  # standby, countdown
    assert rec.session_id is None
    walk = [(1.5, (i // 10) * 10, i * 2, i, R) for i in range(1, 25)]  # 10 m pad resolution
    feed(rec, wall, walk)
    sid = rec.session_id
    assert sid is not None
    feed(rec, wall, [(1.3, 20, 48, 24, R), (0.3, 0, 49, 0, STOPPING), (0.0, 0, 0, 0, STOPPED)])
    assert rec.session_id is None
    s = store.get_session(sid)
    assert s is not None
    assert (s["duration_s"], s["distance_m"], s["steps"], s["max_speed_kmh"]) == (24, 20, 49, 1.5)
    assert s["ended_at"] == wall.t - 1.0  # the STOPPED sample
    assert len(s["samples"]) == 26  # walk + 2 slowing samples, not the countdown or STOPPED


def test_at_most_one_sample_per_second(store: Store) -> None:
    wall = Wall()
    rec = SessionRecorder(store, None, min_session_s=0, wall_clock=wall)
    feed(rec, wall, [(3.0, i, i, i * 0.25, R) for i in range(40)], dt=0.25)  # 4 Hz for 10 s
    rec.end()
    (s,) = store.list_sessions()
    got = store.get_session(s["id"])
    assert got is not None and len(got["samples"]) == 10


def test_short_sessions_are_discarded(store: Store) -> None:
    wall = Wall()
    rec = SessionRecorder(store, None, min_session_s=10, wall_clock=wall)
    feed(rec, wall, [(1.0, 0, 0, i, R) for i in range(5)] + [(0.0, 0, 0, 0, STOPPED)])
    assert store.count_sessions() == 0


def test_disconnect_ends_the_session(store: Store) -> None:
    wall = Wall()
    rec = SessionRecorder(store, None, min_session_s=0, wall_clock=wall)
    feed(rec, wall, [(2.0, 0, i, i, R) for i in range(1, 30)])
    rec.end()
    (s,) = store.list_sessions()
    assert s["ended_at"] is not None and s["duration_s"] == 29


def test_ftms_sessions_have_no_steps(store: Store) -> None:
    wall = Wall()
    rec = SessionRecorder(store, "ftms", min_session_s=0, wall_clock=wall)
    for i in range(1, 20):
        rec.on_sample(Sample(3.0, i * 0.8, None, i, R))
        wall.t += 1
    rec.end()
    assert store.list_sessions()[0]["steps"] is None


def test_reconnect_with_counters_running_resumes_the_session(store: Store) -> None:
    """Hardware check 6: link lost for ~8 s while walking; the pad's counters kept going."""
    wall = Wall()
    rec = SessionRecorder(store, "kingsmith", min_session_s=10, wall_clock=wall)
    feed(rec, wall, [(1.0, 0, i, i, R) for i in range(1, 22)])  # 21 s, 21 steps
    sid = rec.session_id
    rec.link_lost()
    assert rec.session_id is None
    wall.t += 8
    feed(rec, wall, [(1.0, 0, 28 + i, 30 + i, R) for i in range(3)])  # counters continued
    assert rec.session_id == sid
    feed(rec, wall, [(0.3, 0, 31, 0, STOPPING), (0.0, 0, 0, 0, STOPPED)])
    assert store.count_sessions() == 1
    s = store.get_session(sid)  # type: ignore[arg-type]
    assert s is not None and s["ended_at"] is not None
    assert (s["duration_s"], s["steps"]) == (32, 31)  # not 21 + 32


def test_reconnect_with_reset_counters_is_a_new_session(store: Store) -> None:
    wall = Wall()
    rec = SessionRecorder(store, None, min_session_s=10, wall_clock=wall)
    feed(rec, wall, [(1.0, 0, i, i, R) for i in range(1, 30)])
    first = rec.session_id
    rec.link_lost()
    wall.t += 5
    feed(rec, wall, [(1.0, 0, i, i, R) for i in range(1, 20)])  # the pad restarted its counters
    assert rec.session_id not in (None, first)
    rec.end()
    assert store.count_sessions() == 2


def test_late_reconnect_is_a_new_session_and_short_paused_ones_are_dropped(store: Store) -> None:
    wall = Wall()
    rec = SessionRecorder(store, None, min_session_s=10, wall_clock=wall)
    feed(rec, wall, [(1.0, 0, i, i, R) for i in range(1, 6)])  # 5 s: too short on its own
    rec.link_lost()
    assert store.count_sessions() == 1  # kept while it might still be resumed
    wall.t += 120  # past the resume window
    feed(rec, wall, [(1.0, 0, 10 + i, 10 + i, R) for i in range(1, 20)])
    rec.end()
    (only,) = store.list_sessions()
    assert only["duration_s"] == 29  # the short paused session was dropped


def test_pad_back_but_stopped_ends_the_paused_session(store: Store) -> None:
    wall = Wall()
    rec = SessionRecorder(store, None, min_session_s=10, wall_clock=wall)
    feed(rec, wall, [(1.0, 0, i, i, R) for i in range(1, 6)])
    rec.link_lost()
    feed(rec, wall, [(0.0, 0, 0, 0, STOPPED)])  # the owed stop took effect
    assert store.count_sessions() == 0  # 5 s paused session dropped by the minimum rule
