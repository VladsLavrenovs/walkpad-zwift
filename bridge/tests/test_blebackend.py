"""BleBackend against a fake GATT client: protocol selection, live data, control, link loss."""

from __future__ import annotations

import asyncio
import contextlib
import struct
from collections.abc import Callable

import pytest

from conftest import VirtualClock, run_until
from fakegatt import FakeConnector, FakeGattClient, FakeService, SimulatedKsPad, ftms_services, ks_services
from test_kingsmith import status_frame
from walkpad_bridge import ble
from walkpad_bridge.backend import BackendError, BeltState, Sample
from walkpad_bridge import ftms, kingsmith
from walkpad_bridge.backend import NotConnectedError
from walkpad_bridge.blebackend import BleBackend
from walkpad_bridge.cli import _wait_until_moving
from walkpad_bridge.clock import ScaledClock
from walkpad_bridge.ble import Protocol
from walkpad_bridge.safety import SafetyConfig, SafetyEventKind, SpeedController
from walkpad_bridge.kingsmith import MANUAL_MODE, START_BELT, STATUS_QUERY, speed_frame

ADDRESS = "AA:BB:CC:DD:EE:FF"


def make(
    services: Callable[[], list[FakeService]], clock: VirtualClock, **kwargs: object
) -> tuple[BleBackend, FakeConnector]:
    connector = FakeConnector(services, now=clock.now)
    backend = BleBackend(ADDRESS, connector=connector, clock=clock, **kwargs)  # type: ignore[arg-type]
    return backend, connector


async def first_samples(backend: BleBackend, n: int) -> list[Sample]:
    out = []
    async with contextlib.aclosing(backend.samples()) as samples:
        async for sample in samples:
            out.append(sample)
            if len(out) == n:
                break
    return out


@pytest.mark.parametrize(
    ("services", "requested", "expected"),
    [
        (ks_services, None, Protocol.KINGSMITH),
        (ftms_services, None, Protocol.FTMS),
        (lambda: ks_services() + ftms_services(), None, Protocol.FTMS),
        (lambda: ks_services() + ftms_services(), Protocol.KINGSMITH, Protocol.KINGSMITH),
    ],
)
async def test_protocol_selection(
    services: Callable[[], list[FakeService]],
    requested: Protocol | None,
    expected: Protocol,
    clock: VirtualClock,
) -> None:
    backend, _ = make(services, clock, protocol=requested)
    await backend.connect()
    assert backend.protocol is expected
    await backend.disconnect()


async def test_unsupported_device_is_disconnected(clock: VirtualClock) -> None:
    backend, connector = make(lambda: [FakeService(ble.uuid16("180f"), [])], clock)
    with pytest.raises(BackendError, match="neither"):
        await backend.connect()
    assert not connector.client.is_connected
    assert not backend.is_connected


async def test_kingsmith_live_data(clock: VirtualClock) -> None:
    backend, connector = make(ks_services, clock)
    await backend.connect()
    reader = asyncio.create_task(first_samples(backend, 2))
    await asyncio.sleep(0)
    connector.client.send(ble.KS_NOTIFY_CHAR, bytes([0xF8, 0xA7, 0, 0, 0xA7, 0xFD]))  # ignored
    connector.client.send(ble.KS_NOTIFY_CHAR, b"\xf8\xa2\x01")  # truncated: dropped
    connector.client.send(ble.KS_NOTIFY_CHAR, status_frame(speed=30))
    connector.client.send(ble.KS_NOTIFY_CHAR, status_frame(belt_state=0, speed=0))
    first, second = await reader
    assert (first.speed_kmh, first.steps, first.belt) == (3.0, 1500, BeltState.RUNNING)
    assert second.belt is BeltState.STOPPED
    assert backend.belt_state is BeltState.STOPPED
    # A new subscriber gets the latest sample straight away.
    assert (await first_samples(backend, 1))[0] == second
    await backend.disconnect()


async def test_kingsmith_only_ever_writes_the_status_query(clock: VirtualClock) -> None:
    backend, connector = make(ks_services, clock, kingsmith_poll_s=1.0)
    await backend.connect()
    await run_until(lambda: clock.t >= 5)
    writes = connector.client.writes
    assert {w for w in writes} == {(ble.KS_WRITE_CHAR, STATUS_QUERY, False)}
    assert len(writes) == pytest.approx(clock.t + 1, abs=1)  # one query per poll interval
    await backend.disconnect()
    n = len(writes)
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert len(writes) == n  # polling stopped


async def test_ftms_live_data_writes_nothing(clock: VirtualClock) -> None:
    backend, connector = make(ftms_services, clock)
    await backend.connect()
    assert backend.speed_range.max_kmh == 6.0
    reader = asyncio.create_task(first_samples(backend, 1))
    await asyncio.sleep(0)
    connector.client.send(ble.FTMS_TREADMILL_DATA_CHAR, struct.pack("<HH", 0, 250))
    (sample,) = await reader
    assert (sample.speed_kmh, sample.steps, sample.belt) == (2.5, None, BeltState.RUNNING)
    await backend.disconnect()
    assert connector.client.writes == []


async def test_ftms_without_speed_range_uses_default(clock: VirtualClock) -> None:
    backend, _ = make(lambda: ftms_services(speed_range=None), clock)
    await backend.connect()
    assert backend.speed_range.min_kmh == 0.5
    await backend.disconnect()


async def test_link_loss_ends_samples_and_notifies(clock: VirtualClock) -> None:
    backend, connector = make(ks_services, clock)
    lost: list[bool] = []
    backend.add_connection_lost_listener(lambda: lost.append(True))
    await backend.connect()
    reader = asyncio.create_task(first_samples(backend, 99))
    await asyncio.sleep(0)
    connector.client.send(ble.KS_NOTIFY_CHAR, status_frame())
    connector.client.drop()
    assert len(await reader) == 1
    assert lost == [True]
    assert not backend.is_connected
    for _ in range(3):
        await asyncio.sleep(0)  # let the handler's stop task run
    n = len(connector.client.writes)
    for _ in range(10):
        await asyncio.sleep(0)
    assert len(connector.client.writes) == n  # poller cancelled

    # Reconnect: a fresh client, same protocol.
    await backend.connect()
    assert len(connector.clients) == 2 and backend.protocol is Protocol.KINGSMITH
    await backend.disconnect()


async def test_deliberate_disconnect_does_not_notify(clock: VirtualClock) -> None:
    backend, connector = make(ftms_services, clock)
    lost: list[bool] = []
    backend.add_connection_lost_listener(lambda: lost.append(True))
    await backend.connect()
    await backend.disconnect()
    assert lost == []
    assert not connector.client.is_connected


# --- belt control -------------------------------------------------------------------------------


def ks_commands(connector: FakeConnector) -> list[bytes]:
    return [data for _, data, _ in connector.client.writes if data != STATUS_QUERY]


async def ks_connected(clock: VirtualClock, status: bytes) -> tuple[BleBackend, FakeConnector]:
    backend, connector = make(ks_services, clock)
    await backend.connect()
    connector.client.send(ble.KS_NOTIFY_CHAR, status)
    return backend, connector


async def test_kingsmith_start_switches_to_manual_then_starts(clock: VirtualClock) -> None:
    standby = status_frame(belt_state=5, speed=0, mode=2)  # what the owner's idle pad reports
    backend, connector = await ks_connected(clock, standby)
    t0 = clock.t
    await backend.start()
    assert ks_commands(connector) == [MANUAL_MODE, START_BELT]
    times = [t for (_, data, _), t in zip(connector.client.writes, connector.client.write_times)
             if data in (MANUAL_MODE, START_BELT)]
    assert times[1] - times[0] >= kingsmith.MODE_SWITCH_SETTLE_S
    assert times[0] >= t0
    await backend.disconnect()


async def test_kingsmith_start_always_switches_to_manual(clock: VirtualClock) -> None:
    # Even when the status already says manual: the owner's pad ignored a bare start after
    # a long idle in manual mode.
    backend, connector = await ks_connected(clock, status_frame(belt_state=0, speed=0, mode=1))
    await backend.start()
    assert ks_commands(connector) == [MANUAL_MODE, START_BELT]
    await backend.disconnect()


async def test_kingsmith_speed_and_stop_frames(clock: VirtualClock) -> None:
    backend, connector = await ks_connected(clock, status_frame(belt_state=1, speed=10))
    await backend.set_speed(1.5)
    await backend.set_speed(2.0)
    await backend.stop()
    assert ks_commands(connector) == [speed_frame(1.5), speed_frame(2.0), speed_frame(0)]
    assert speed_frame(1.5) == bytes([0xF7, 0xA2, 0x01, 15, 0xB2, 0xFD])
    await backend.disconnect()


async def test_kingsmith_writes_keep_a_minimum_gap(clock: VirtualClock) -> None:
    backend, connector = await ks_connected(clock, status_frame(belt_state=1, speed=10))
    for kmh in (1.5, 2.0, 2.5):
        await backend.set_speed(kmh)
    await run_until(lambda: clock.t >= 5)
    await backend.stop()
    times = connector.client.write_times
    gaps = [b - a for a, b in zip(times, times[1:])]
    assert min(gaps) >= kingsmith.MIN_WRITE_GAP_S - 1e-9
    await backend.disconnect()


@pytest.mark.parametrize(
    "status",
    [
        status_frame(belt_state=1, speed=25),  # running
        status_frame(belt_state=9, speed=0),  # start countdown
        status_frame(belt_state=0, speed=15),  # still slowing down
    ],
)
async def test_start_refused_unless_belt_known_stopped(clock: VirtualClock, status: bytes) -> None:
    backend, connector = await ks_connected(clock, status)
    with pytest.raises(BackendError, match="not stopped"):
        await backend.start()
    assert ks_commands(connector) == []
    await backend.disconnect()


async def test_start_refused_without_any_status(clock: VirtualClock) -> None:
    backend, connector = make(ks_services, clock)
    await backend.connect()
    with pytest.raises(BackendError, match="no status"):
        await backend.start()
    assert ks_commands(connector) == []
    await backend.disconnect()


async def test_speed_refused_unless_running_and_in_range(clock: VirtualClock) -> None:
    backend, connector = await ks_connected(clock, status_frame(belt_state=5, speed=0, mode=2))
    with pytest.raises(BackendError, match="not running"):
        await backend.set_speed(2.0)
    connector.client.send(ble.KS_NOTIFY_CHAR, status_frame(belt_state=1, speed=20))
    for bad in (0.4, 6.1):
        with pytest.raises(ValueError, match="outside device range"):
            await backend.set_speed(bad)
    assert ks_commands(connector) == []
    await backend.disconnect()


async def test_stop_always_sent(clock: VirtualClock) -> None:
    backend, connector = await ks_connected(clock, status_frame(belt_state=5, speed=0, mode=2))
    await backend.stop()  # even when the pad says stopped: its state may be stale
    assert ks_commands(connector) == [speed_frame(0)]
    await backend.disconnect()


async def test_commands_need_a_connection(clock: VirtualClock) -> None:
    backend, _ = make(ks_services, clock)
    with pytest.raises(NotConnectedError):
        await backend.stop()


def cp_writes(connector: FakeConnector) -> list[bytes]:
    return [data for uuid, data, _ in connector.client.writes if uuid == ble.FTMS_CONTROL_POINT_CHAR]


async def test_ftms_control_requests_control_once(clock: VirtualClock) -> None:
    backend, connector = make(ftms_services, clock)
    await backend.connect()
    connector.client.send(ble.FTMS_TREADMILL_DATA_CHAR, struct.pack("<HH", 0, 0))
    await backend.start()
    connector.client.send(ble.FTMS_TREADMILL_DATA_CHAR, struct.pack("<HH", 0, 100))
    await backend.set_speed(2.5)
    await backend.stop()
    assert cp_writes(connector) == [
        bytes([0x00]), bytes([0x07]), bytes([0x02, 0xFA, 0x00]), bytes([0x08, 0x01])
    ]
    assert all(response for uuid, _, response in connector.client.writes
               if uuid == ble.FTMS_CONTROL_POINT_CHAR)
    await backend.disconnect()


async def test_ftms_refusal_raises_and_control_is_requested_again(clock: VirtualClock) -> None:
    backend, connector = make(ftms_services, clock)
    await backend.connect()
    connector.client.cp_result = 0x05  # control not permitted
    with pytest.raises(BackendError, match="control not permitted"):
        await backend.stop()
    connector.client.cp_result = 0x01
    await backend.stop()
    assert cp_writes(connector) == [bytes([0x00]), bytes([0x00]), bytes([0x08, 0x01])]
    await backend.disconnect()


async def test_ftms_no_response_times_out(
    clock: VirtualClock, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(ftms, "CONTROL_TIMEOUT_S", 0.01)
    backend, connector = make(ftms_services, clock)
    await backend.connect()
    connector.client.cp_result = None
    with pytest.raises(BackendError, match="no response"):
        await backend.stop()
    await backend.disconnect()


async def test_link_loss_while_walking_reconnects_and_stops(clock: VirtualClock) -> None:
    """The CLAUDE.md rule, on the real backend: BLE drops with the belt running -> stop it."""
    connector = FakeConnector(ks_services, now=clock.now)
    connector.client_class = SimulatedKsPad
    backend = BleBackend(ADDRESS, connector=connector, clock=clock)
    await backend.connect()
    controller = SpeedController(backend, SafetyConfig(), clock)
    await run_until(lambda: backend.belt_state is BeltState.STOPPED and backend._last is not None)
    await controller.start(client="cli")
    await run_until(lambda: backend.belt_state is BeltState.RUNNING)
    await controller.set_speed(2.0, client="cli")

    walking_pad = connector.client
    walking_pad.drop()
    assert controller.recovery_task is not None
    assert await controller.recovery_task is True
    assert len(connector.clients) == 2
    stops = [d for _, d, _ in connector.client.writes if d == speed_frame(0)]
    assert stops == [speed_frame(0)]
    assert controller.controlling_client is None
    await controller.close()


# --- the 2026-09-30 incident: pad ran up to its own start speed past the cap ---------------------


async def controlled_start(
    pad: type[SimulatedKsPad], cap: float, target: float, seconds: float
) -> tuple[SpeedController, FakeConnector, list[str]]:
    """Start through SpeedController the way the CLI does, feeding samples to observe().

    Runs on a scaled real-time clock: the virtual clock lets the poll loop race ahead of
    everything else, which hides exactly the timing this is about.
    """
    clock = ScaledClock(20)
    t0 = clock.now()
    connector = FakeConnector(ks_services, now=clock.now)
    connector.client_class = pad
    backend = BleBackend(ADDRESS, connector=connector, clock=clock)
    await backend.connect()
    controller = SpeedController(backend, SafetyConfig(max_speed_kmh=cap), clock)
    events: list[str] = []
    controller.add_event_listener(lambda e: events.append(e.kind))

    async def feed() -> None:
        async for sample in backend.samples():
            controller.observe(sample)

    feeder = asyncio.create_task(feed())
    await run_until(lambda: backend._last is not None)
    await controller.start(client="cli")
    await _wait_until_moving(backend)  # event-driven, exactly as the CLI waits
    await controller.set_speed(target, client="cli")
    await clock.sleep(seconds - (clock.now() - t0))
    feeder.cancel()
    return controller, connector, events


def speeds_sent(connector: FakeConnector) -> list[float]:
    return [d[3] / 10 for _, d, _ in connector.client.writes if d[1:3] == bytes([0xA2, 0x01])]


async def test_pad_obeying_the_pin_never_passes_the_cap() -> None:
    class Pad(SimulatedKsPad):
        run_up_kmh = 2.5

    controller, connector, events = await controlled_start(Pad, cap=1.5, target=1.0, seconds=20)
    assert connector.client.max_speed_seen <= 10  # pinned at 1.0 as soon as it moved
    assert max(speeds_sent(connector)) <= 1.5
    assert events == []
    await controller.close()


async def test_pad_ignoring_the_pin_is_brought_back_under_the_cap() -> None:
    class Pad(SimulatedKsPad):
        run_up_kmh = 2.5
        deaf_during_run_up = True

    controller, connector, events = await controlled_start(Pad, cap=1.5, target=1.0, seconds=20)
    assert connector.client.speed == 10  # back at the 1.0 target
    assert max(speeds_sent(connector)) <= 1.5  # never commanded above the cap
    assert SafetyEventKind.FAILSAFE_STOP not in events
    await controller.close()


async def test_pad_ignoring_speed_commands_is_stopped_by_the_failsafe() -> None:
    class Pad(SimulatedKsPad):
        run_up_kmh = 2.5
        deaf = True

    controller, connector, events = await controlled_start(Pad, cap=1.5, target=1.0, seconds=20)
    assert SafetyEventKind.FAILSAFE_STOP in events
    assert connector.client.speed == 0 and connector.client.state == 0
    assert max(speeds_sent(connector)) <= 1.5
    await controller.close()


async def test_uncontrolled_belt_above_cap_is_only_reported(clock: VirtualClock) -> None:
    """Started with the pad's remote, bridge only watching: warn, do not intervene."""

    class Pad(SimulatedKsPad):
        def __init__(self, *args: object, **kwargs: object) -> None:
            super().__init__(*args, **kwargs)
            self.state, self.mode, self.speed = 1, 1, 25

    connector = FakeConnector(ks_services, now=clock.now)
    connector.client_class = Pad
    backend = BleBackend(ADDRESS, connector=connector, clock=clock)
    await backend.connect()
    controller = SpeedController(backend, SafetyConfig(max_speed_kmh=1.5), clock)
    events: list[str] = []
    controller.add_event_listener(lambda e: events.append(e.kind))

    async def feed() -> None:
        async for sample in backend.samples():
            controller.observe(sample)

    feeder = asyncio.create_task(feed())
    await run_until(lambda: clock.t >= 20, max_yields=100_000)
    feeder.cancel()
    assert events == [SafetyEventKind.BELT_ABOVE_CAP]
    assert speeds_sent(connector) == []
    await backend.disconnect()


async def test_spurious_drop_during_setup_does_not_leave_the_link_open(clock: VirtualClock) -> None:
    """Seen on hardware: a late drop report during setup; the half-open link must be closed."""

    class LateDropClient(FakeGattClient):
        async def start_notify(self, spec, callback) -> None:  # type: ignore[no-untyped-def]
            await super().start_notify(spec, callback)
            self.on_disconnect()  # the drop report arrives mid-setup; the link itself is fine

    connector = FakeConnector(ks_services, now=clock.now)
    connector.client_class = LateDropClient
    backend = BleBackend(ADDRESS, connector=connector, clock=clock)
    with pytest.raises(BackendError, match="dropped during setup"):
        await backend.connect()
    assert not connector.client.is_connected
    assert not backend.is_connected
