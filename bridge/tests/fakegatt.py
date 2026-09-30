"""A stand-in for bleak's BleakClient: just the parts the bridge uses. No Bluetooth involved."""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from walkpad_bridge import ble


@dataclass
class FakeDescriptor:
    uuid: str


@dataclass
class FakeChar:
    uuid: str
    handle: int
    properties: list[str]
    description: str = "Unknown"
    value: bytes | None = None
    read_error: Exception | None = None
    descriptors: list[FakeDescriptor] = field(default_factory=list)


@dataclass
class FakeService:
    uuid: str
    characteristics: list[FakeChar]
    description: str = "Unknown"


def ks_services() -> list[FakeService]:
    return [
        FakeService(ble.uuid16("180a"), [
            FakeChar(ble.uuid16("2a24"), 3, ["read"], "Model Number String", b"KS-ST-A1P"),
        ], "Device Information"),
        FakeService(ble.KS_SERVICE, [
            FakeChar(ble.KS_NOTIFY_CHAR, 10, ["read", "notify"], value=b"\x00",
                     descriptors=[FakeDescriptor(ble.uuid16("2902"))]),
            FakeChar(ble.KS_WRITE_CHAR, 13, ["write-without-response", "write"]),
        ]),
    ]


def ftms_services(speed_range: bytes | None = bytes([50, 0, 88, 2, 10, 0])) -> list[FakeService]:
    chars = [
        FakeChar(ble.FTMS_FEATURE_CHAR, 20, ["read"], "Fitness Machine Feature", bytes(8)),
        FakeChar(ble.FTMS_TREADMILL_DATA_CHAR, 22, ["notify"], "Treadmill Data"),
        FakeChar(ble.FTMS_CONTROL_POINT_CHAR, 25, ["write", "indicate"], "Control Point"),
    ]
    if speed_range is not None:
        chars.append(
            FakeChar(ble.FTMS_SPEED_RANGE_CHAR, 28, ["read"], "Supported Speed Range", speed_range)
        )
    return [FakeService(ble.FTMS_SERVICE, chars, "Fitness Machine")]


class FakeGattClient:
    """Answers FTMS Control Point writes with `80 <op> <cp_result>` (unless cp_result is None)."""

    def __init__(
        self,
        services: list[FakeService],
        on_disconnect: Callable[[], None],
        now: Callable[[], float] = lambda: 0.0,
    ) -> None:
        self.services = services
        self.on_disconnect = on_disconnect
        self.now = now
        self.is_connected = True
        self.writes: list[tuple[str, bytes, bool | None]] = []
        self.write_times: list[float] = []
        self.notify: dict[str, Callable[[Any, bytearray], Any]] = {}
        self.cp_result: int | None = 0x01

    def _char(self, spec: Any) -> FakeChar:
        uuid = spec if isinstance(spec, str) else spec.uuid
        for service in self.services:
            for char in service.characteristics:
                if char.uuid == uuid:
                    return char
        raise KeyError(f"no characteristic {uuid}")

    async def read_gatt_char(self, spec: Any) -> bytearray:
        char = self._char(spec)
        if char.read_error is not None:
            raise char.read_error
        if char.value is None:
            raise RuntimeError("not readable")
        return bytearray(char.value)

    async def write_gatt_char(self, spec: Any, data: bytes, response: bool | None = None) -> None:
        uuid = self._char(spec).uuid
        self.writes.append((uuid, bytes(data), response))
        self.write_times.append(self.now())
        cp = ble.FTMS_CONTROL_POINT_CHAR
        if uuid == cp and cp in self.notify and self.cp_result is not None:
            reply = bytes([0x80, data[0], self.cp_result])
            asyncio.get_running_loop().call_soon(self.send, cp, reply)

    async def start_notify(self, spec: Any, callback: Callable[[Any, bytearray], Any]) -> None:
        char = self._char(spec)
        assert "notify" in char.properties or "indicate" in char.properties
        self.notify[char.uuid] = callback

    async def disconnect(self) -> None:
        if self.is_connected:
            self.is_connected = False
            self.on_disconnect()

    def send(self, uuid: str, data: bytes) -> None:
        """Deliver a notification from the 'device'."""
        result = self.notify[uuid](self._char(uuid), bytearray(data))
        assert not inspect.isawaitable(result)

    def drop(self) -> None:
        """Link loss, as when the pad is switched off."""
        self.is_connected = False
        self.on_disconnect()


class FakeConnector:
    """Replaces `ble.connect_client`. Records every client it hands out."""

    def __init__(
        self,
        services: Callable[[], list[FakeService]],
        fail: int = 0,
        now: Callable[[], float] = lambda: 0.0,
    ) -> None:
        self.services = services
        self.fail = fail
        self.now = now
        self.client_class: type[FakeGattClient] = FakeGattClient
        self.clients: list[FakeGattClient] = []

    async def __call__(
        self, address: str, timeout_s: float, on_disconnect: Callable[[], None]
    ) -> FakeGattClient:
        if self.fail > 0:
            self.fail -= 1
            raise ble.BackendError(f"{address} not found")
        client = self.client_class(self.services(), on_disconnect, self.now)
        self.clients.append(client)
        return client

    @property
    def client(self) -> FakeGattClient:
        return self.clients[-1]


class SimulatedKsPad(FakeGattClient):
    """A KingSmith pad: answers status queries and obeys start / speed / stop frames.

    Starts idle in standby like the owner's pad. `start` needs manual mode first and puts the
    belt at `start_kmh`; speed changes apply instantly (the real belt takes a moment).

    With `run_up_kmh` it behaves like the owner's pad did on 2026-09-30: count down 9, 8, 7,
    then run up by 0.8 km/h per status report from 1.0 to `run_up_kmh` (its own start-speed
    setting). With `deaf_during_run_up` it ignores speed commands until the run-up is over;
    with `deaf` it ignores all non-zero speed commands.
    """

    start_kmh = 1.0
    run_up_kmh: float | None = None
    deaf_during_run_up = False
    deaf = False

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.state, self.mode, self.speed = 5, 2, 0  # standby
        self.ignore_stops = 0  # drop this many stop frames, like a lost BLE write
        self.countdown: list[int] = []
        self.running_up = False
        self.max_speed_seen = 0

    async def write_gatt_char(self, spec: Any, data: bytes, response: bool | None = None) -> None:
        await super().write_gatt_char(spec, data, response)
        cmd = bytes(data)[1:4]
        if cmd == bytes([0xA2, 0x00, 0x00]):
            self._advance()
            status = bytes([0xA2, self.state, self.speed, self.mode, *bytes(13)])
            frame = bytes([0xF8, *status, sum(status) % 256, 0xFD])
            asyncio.get_running_loop().call_soon(self.send, ble.KS_NOTIFY_CHAR, frame)
        elif cmd[:2] == bytes([0xA2, 0x02]):
            self.mode = cmd[2]
            self.state = 0
        elif cmd == bytes([0xA2, 0x04, 0x01]) and self.mode == 1:
            if self.run_up_kmh is None:
                self.state, self.speed = 1, round(self.start_kmh * 10)
            else:
                self.countdown = [9, 8, 7]
                self.state = self.countdown.pop(0)
        elif cmd[:2] == bytes([0xA2, 0x01]):
            if cmd[2] == 0:
                if self.ignore_stops > 0:
                    self.ignore_stops -= 1
                    return
                self.speed, self.state, self.running_up, self.countdown = 0, 0, False, []
                return
            if self.deaf or (self.deaf_during_run_up and (self.running_up or self.countdown)):
                return
            self.running_up = False
            self.speed = cmd[2]

    def _advance(self) -> None:
        """One status report's worth of the pad's own behaviour."""
        if self.countdown:
            self.state = self.countdown.pop(0)
        elif self.state in (7, 8, 9):
            self.state, self.speed, self.running_up = 1, 10, True
        elif self.running_up and self.run_up_kmh is not None:
            self.speed = min(self.speed + 8, round(self.run_up_kmh * 10))
            self.running_up = self.speed < round(self.run_up_kmh * 10)
        self.max_speed_seen = max(self.max_speed_seen, self.speed)
