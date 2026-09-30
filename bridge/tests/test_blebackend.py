"""BleBackend against a fake GATT client: protocol selection, live data, read-only, link loss."""

from __future__ import annotations

import asyncio
import contextlib
import struct
from collections.abc import Callable

import pytest

from conftest import VirtualClock, run_until
from fakegatt import FakeConnector, FakeService, ftms_services, ks_services
from test_kingsmith import status_frame
from walkpad_bridge import ble
from walkpad_bridge.backend import BackendError, BeltState, Sample
from walkpad_bridge.blebackend import BleBackend, ControlNotSupportedError
from walkpad_bridge.ble import Protocol
from walkpad_bridge.kingsmith import STATUS_QUERY

ADDRESS = "AA:BB:CC:DD:EE:FF"


def make(
    services: Callable[[], list[FakeService]], clock: VirtualClock, **kwargs: object
) -> tuple[BleBackend, FakeConnector]:
    connector = FakeConnector(services)
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
    for call in (backend.start(), backend.stop(), backend.set_speed(3.0)):
        with pytest.raises(ControlNotSupportedError):
            await call
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
    with pytest.raises(ControlNotSupportedError):
        await backend.set_speed(3.0)
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
