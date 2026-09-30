"""BridgeService on the FAKE pad and virtual time: sessions, control, grace period, link loss."""

from __future__ import annotations

import asyncio
import json
import socket
from pathlib import Path

import pytest

from conftest import VirtualClock, run_until
from walkpad_bridge.backend import BeltState
from walkpad_bridge.config import Config, StorageConfig, UdpConfig
from walkpad_bridge.fake import FakeBackend
from walkpad_bridge.service import BridgeService, ControlError
from walkpad_bridge.storage import Store


class Wall:
    def __init__(self, clock: VirtualClock) -> None:
        self.clock = clock

    def __call__(self) -> float:
        return 1_790_000_000 + self.clock.t


async def make_service(
    tmp_path: Path, clock: VirtualClock, config: Config | None = None, **fake_kwargs: object
) -> tuple[BridgeService, FakeBackend]:
    fake = FakeBackend(clock=clock, seed=1, **fake_kwargs)  # type: ignore[arg-type]
    cfg = config or Config(storage=StorageConfig(min_session_s=0))
    service = BridgeService(fake, cfg, Store(tmp_path / "w.sqlite"), protocol_name="fake",
                            clock=clock, wall_clock=Wall(clock))
    await service.start()
    await run_until(lambda: service.controller is not None)
    return service, fake


async def walking(service: BridgeService, fake: FakeBackend, client: str, kmh: float) -> None:
    service.client_connected(client)
    await service.control_start(client, kmh)
    await run_until(lambda: service._start_task is not None and service._start_task.done()
                    and fake.speed_kmh == kmh, max_yields=100_000)


async def test_session_recorded_from_start_to_stop(tmp_path: Path, clock: VirtualClock) -> None:
    service, fake = await make_service(tmp_path, clock)
    await walking(service, fake, "page", 3.0)
    assert service.recorder.session_id is not None
    await run_until(lambda: clock.t > 60, max_yields=100_000)
    await service.control_stop("page")
    await run_until(lambda: service.recorder.session_id is None, max_yields=100_000)
    (s,) = service.store.list_sessions()
    assert s["ended_at"] is not None and s["distance_m"] > 30 and s["max_speed_kmh"] == 3.0
    assert s["protocol"] == "fake"
    await service.close()


async def test_control_needs_a_live_websocket(tmp_path: Path, clock: VirtualClock) -> None:
    service, _ = await make_service(tmp_path, clock)
    with pytest.raises(ControlError, match="WebSocket"):
        await service.control_start("curl", 2.0)
    await service.control_stop("curl")  # stopping never needs one
    await service.close()


async def test_start_and_speed_are_capped_and_guarded(tmp_path: Path, clock: VirtualClock) -> None:
    service, fake = await make_service(tmp_path, clock)
    service.client_connected("page")
    assert await service.control_start("page", 9.0) == 6.0
    with pytest.raises(ControlError, match="still starting"):
        await service.control_speed("page", 2.0)
    await run_until(lambda: service._start_task.done(), max_yields=100_000)  # type: ignore[union-attr]
    with pytest.raises(ControlError, match="stop it first"):
        await service.control_start("page", 2.0)
    assert await service.control_speed("page", 7.5) == 6.0
    await service.close()
    assert fake.belt_state is not BeltState.RUNNING  # shutdown stops the belt


async def test_page_refresh_within_grace_keeps_walking(tmp_path: Path, clock: VirtualClock) -> None:
    service, fake = await make_service(tmp_path, clock)
    await walking(service, fake, "page", 3.0)
    service.client_disconnected("page")
    await clock.sleep(2)
    service.client_connected("page")  # back after 2 s of a 5 s grace
    await run_until(lambda: clock.t > 30, max_yields=100_000)
    assert fake.belt_state is BeltState.RUNNING and fake.speed_kmh == 3.0
    await service.close()


async def test_gone_client_ramps_down_then_stops(tmp_path: Path, clock: VirtualClock) -> None:
    service, fake = await make_service(tmp_path, clock)
    await walking(service, fake, "page", 3.0)
    n = len(fake.commands)
    service.client_disconnected("page")
    t_gone = clock.t
    await run_until(lambda: fake.belt_state is BeltState.STOPPED, max_yields=200_000)
    after = fake.commands[n:]
    speeds = [c.kmh for c in after if c.name == "set_speed"]
    assert speeds == [2.5, 2.0, 1.5, 1.0, 0.5]  # at the ramp rate, down to the device minimum
    assert after[0].t >= t_gone + 5.0  # not before the grace period
    assert after[-1].name == "stop"
    assert service.controller.controlling_client is None  # type: ignore[union-attr]
    await service.close()


async def test_other_client_taking_over_cancels_the_ramp_down(
    tmp_path: Path, clock: VirtualClock
) -> None:
    service, fake = await make_service(tmp_path, clock)
    await walking(service, fake, "page", 3.0)
    service.client_disconnected("page")
    await run_until(lambda: any(c.kmh == 2.0 for c in fake.commands), max_yields=200_000)
    service.client_connected("phone")
    await service.control_speed("phone", 2.5)
    await run_until(lambda: clock.t > 60, max_yields=200_000)
    assert fake.belt_state is BeltState.RUNNING and fake.speed_kmh == 2.5
    assert service.controller.controlling_client == "phone"  # type: ignore[union-attr]
    await service.close()


async def test_link_loss_stops_belt_and_ends_session(tmp_path: Path, clock: VirtualClock) -> None:
    service, fake = await make_service(tmp_path, clock)
    await walking(service, fake, "page", 3.0)
    await run_until(lambda: clock.t > 30, max_yields=100_000)
    sid = service.recorder.session_id
    fake.simulate_connection_loss()
    await run_until(lambda: fake.commands[-1].name == "stop", max_yields=100_000)
    s = service.store.get_session(sid, with_samples=False)  # type: ignore[arg-type]
    assert s is not None and s["ended_at"] is not None
    await run_until(lambda: fake.belt_state is BeltState.STOPPED, max_yields=100_000)
    assert service.backend.is_connected  # reconnected, live data flows again
    await service.close()


async def test_unreachable_pad_is_retried(tmp_path: Path, clock: VirtualClock) -> None:
    service, fake = await make_service(tmp_path, clock, fail_connects=3)
    assert fake.connect_attempts == 4
    assert clock.t >= 15  # every reconnect_interval_s (5 s)
    await service.close()


async def test_live_messages_and_udp(tmp_path: Path, clock: VirtualClock) -> None:
    receiver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    receiver.bind(("127.0.0.1", 0))
    receiver.setblocking(False)
    port = receiver.getsockname()[1]
    cfg = Config(udp=UdpConfig(enabled=True, host="127.0.0.1", port=port))
    service, fake = await make_service(tmp_path, clock, config=cfg, initial_speed_kmh=2.0)
    queue = service.subscribe()
    await run_until(lambda: queue.qsize() >= 3, max_yields=100_000)
    message = queue.get_nowait()
    assert message["type"] == "sample" and message["speed_kmh"] == 2.0
    await asyncio.sleep(0.05)
    datagram = json.loads(receiver.recv(4096))
    assert datagram["type"] == "sample" and datagram["belt"] == "running"
    receiver.close()
    await service.close()


async def test_loop_survives_unexpected_errors(tmp_path: Path, clock: VirtualClock) -> None:
    service, fake = await make_service(tmp_path, clock)
    calls = {"n": 0}

    def flaky_observe(sample):  # type: ignore[no-untyped-def]
        calls["n"] += 1
        if calls["n"] == 3:
            raise RuntimeError("boom")

    service.controller.observe = flaky_observe  # type: ignore[union-attr,method-assign]
    await run_until(lambda: calls["n"] >= 6, max_yields=100_000)  # still reading after the error
    await service.close()


async def test_owed_stop_is_sent_when_the_service_reconnects(
    tmp_path: Path, clock: VirtualClock
) -> None:
    """Replays hardware check 6: Bluetooth off for 3 s; the controller's 3 quick retries all
    fail, then the service's reconnect loop gets the pad back. It must stop the belt first."""
    service, fake = await make_service(tmp_path, clock)
    await walking(service, fake, "page", 1.0)
    fake.fail_connects = 3
    fake.simulate_connection_loss()
    await run_until(lambda: service.backend.is_connected and fake.commands[-1].name == "stop",
                    max_yields=200_000)
    assert fake.connect_attempts >= 5  # 3 failed recovery attempts + the service's reconnect
    assert not service.controller.stop_owed  # type: ignore[union-attr]
    await run_until(lambda: fake.belt_state is BeltState.STOPPED, max_yields=200_000)
    await service.close()
