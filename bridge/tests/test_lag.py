import pytest

from conftest import VirtualClock
from walkpad_bridge.backend import BeltState, Sample
from walkpad_bridge.lag import LagMeter


def s(kmh: float, belt: BeltState = BeltState.RUNNING) -> Sample:
    return Sample(speed_kmh=kmh, distance_m=0, steps=0, elapsed_s=0, belt=belt)


def test_measures_each_command() -> None:
    clock = VirtualClock()
    lag = LagMeter(clock)
    lag.on_command("start")
    clock.t = 1.0
    lag.observe(s(0.0, BeltState.STOPPED))
    clock.t = 3.0
    lag.observe(s(1.0))  # moving: start took 3 s
    lag.on_command("set_speed", 1.5)
    clock.t = 4.0
    lag.observe(s(1.2))
    clock.t = 5.0
    lag.observe(s(1.5))  # 2 s
    lag.on_command("stop")
    clock.t = 6.0
    lag.observe(s(0.0, BeltState.STOPPING))  # zero but not reported stopped yet
    clock.t = 7.0
    lag.observe(s(0.0, BeltState.STOPPED))  # 2 s
    assert [(r.command, r.lag_s) for r in lag.records] == [
        ("start", 3.0), ("set_speed", 2.0), ("stop", 2.0)
    ]
    summary = lag.summary()
    assert summary[0].startswith("start     n=1  lag min 3.0 s")
    assert len(summary) == 3


def test_superseded_and_unfinished_commands() -> None:
    clock = VirtualClock()
    lag = LagMeter(clock)
    lag.on_command("set_speed", 1.0)
    clock.t = 1
    lag.on_command("set_speed", 1.5)  # ramp step before the belt got to 1.0
    clock.t = 2.5
    lag.observe(s(1.5))
    lag.on_command("stop")
    assert [r.lag_s for r in lag.records] == [None, pytest.approx(1.5)]
    summary = lag.summary()
    assert "(1 superseded before the belt got there)" in summary[0]
    assert summary[-1] == "last command (stop) never showed in the pad's status"


def test_speed_match_uses_device_resolution() -> None:
    clock = VirtualClock()
    lag = LagMeter(clock, resolution_kmh=0.1)
    lag.on_command("set_speed", 2.0)
    lag.observe(s(1.9))
    assert lag.records == []
    lag.observe(s(2.0))
    assert len(lag.records) == 1
