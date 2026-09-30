"""A stand-in for bleak's BleakClient: just the parts the bridge uses. No Bluetooth involved."""

from __future__ import annotations

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
    def __init__(self, services: list[FakeService], on_disconnect: Callable[[], None]) -> None:
        self.services = services
        self.on_disconnect = on_disconnect
        self.is_connected = True
        self.writes: list[tuple[str, bytes, bool | None]] = []
        self.notify: dict[str, Callable[[Any, bytearray], Any]] = {}

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
        self.writes.append((self._char(spec).uuid, bytes(data), response))

    async def start_notify(self, spec: Any, callback: Callable[[Any, bytearray], Any]) -> None:
        char = self._char(spec)
        assert "notify" in char.properties
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

    def __init__(self, services: Callable[[], list[FakeService]], fail: int = 0) -> None:
        self.services = services
        self.fail = fail
        self.client_class: type[FakeGattClient] = FakeGattClient
        self.clients: list[FakeGattClient] = []

    async def __call__(
        self, address: str, timeout_s: float, on_disconnect: Callable[[], None]
    ) -> FakeGattClient:
        if self.fail > 0:
            self.fail -= 1
            raise ble.BackendError(f"{address} not found")
        client = self.client_class(self.services(), on_disconnect)
        self.clients.append(client)
        return client

    @property
    def client(self) -> FakeGattClient:
        return self.clients[-1]
