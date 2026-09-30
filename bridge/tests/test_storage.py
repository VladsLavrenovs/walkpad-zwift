from pathlib import Path

from walkpad_bridge.backend import BeltState, Sample
from walkpad_bridge.storage import Store, Totals


def sample(kmh: float = 3.0) -> Sample:
    return Sample(speed_kmh=kmh, distance_m=10, steps=5, elapsed_s=12, belt=BeltState.RUNNING)


def test_session_roundtrip(tmp_path: Path) -> None:
    store = Store(tmp_path / "sub" / "walk.sqlite")  # creates the directory
    sid = store.open_session(1000.0, "kingsmith")
    store.add_sample(sid, 1001.0, sample(), Totals(12, 10, 5, 3.0))
    store.add_sample(sid, 1002.0, sample(3.6), Totals(3600, 3600, 5000, 3.6))
    store.close_session(sid, 1003.0, Totals(3600, 3600, 5000, 3.6))
    got = store.get_session(sid)
    assert got is not None
    assert (got["ended_at"], got["distance_m"], got["steps"]) == (1003.0, 3600, 5000)
    assert got["protocol"] == "kingsmith"
    assert got["avg_speed_kmh"] == 3.6
    assert [s["t"] for s in got["samples"]] == [1001.0, 1002.0]
    assert store.list_sessions()[0]["id"] == sid
    assert "samples" not in store.list_sessions()[0]
    assert store.count_sessions() == 1
    assert store.get_session(sid + 1) is None
    store.close()
    # Persists across restarts.
    assert Store(tmp_path / "sub" / "walk.sqlite").count_sessions() == 1


def test_totals_survive_a_crash_and_dangling_sessions_are_closed(tmp_path: Path) -> None:
    store = Store(tmp_path / "w.sqlite")
    long = store.open_session(100.0, None)
    store.add_sample(long, 160.0, sample(), Totals(60, 50, 80, 3.0))
    short = store.open_session(200.0, None)
    store.add_sample(short, 203.0, sample(), Totals(3, 2, 4, 3.0))
    store.close()  # "crash": neither session was closed

    store = Store(tmp_path / "w.sqlite")
    assert store.close_dangling(min_session_s=10) == 2
    assert store.count_sessions() == 1
    s = store.get_session(long, with_samples=False)
    assert s is not None and s["ended_at"] == 160.0 and s["distance_m"] == 50


def test_deleting_a_session_deletes_its_samples(tmp_path: Path) -> None:
    store = Store(tmp_path / "w.sqlite")
    sid = store.open_session(1.0, None)
    store.add_sample(sid, 2.0, sample(), Totals())
    store.delete_session(sid)
    assert store.db.execute("SELECT COUNT(*) FROM samples").fetchone()[0] == 0
