"""Shared BLE bits (bleak on BlueZ): UUIDs, scanning, connecting, GATT dumps, protocol detection."""

from __future__ import annotations

import enum
import re
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

from .backend import BackendError, Sample, SpeedRange


def uuid16(short: str) -> str:
    """Full 128-bit form of a 16-bit Bluetooth SIG UUID, lowercase (as bleak reports it)."""
    return f"0000{short.lower()}-0000-1000-8000-00805f9b34fb"


# KingSmith proprietary protocol (reference: ph4-walkingpad).
KS_SERVICE = uuid16("fe00")
KS_NOTIFY_CHAR = uuid16("fe01")
KS_WRITE_CHAR = uuid16("fe02")

# Bluetooth SIG Fitness Machine Service.
FTMS_SERVICE = uuid16("1826")
FTMS_FEATURE_CHAR = uuid16("2acc")
FTMS_TREADMILL_DATA_CHAR = uuid16("2acd")
FTMS_SPEED_RANGE_CHAR = uuid16("2ad4")
FTMS_CONTROL_POINT_CHAR = uuid16("2ad9")  # never written: real-device control is not implemented

LIKELY_NAME = re.compile(r"walkingpad|kingsmith|^ks[-_]", re.IGNORECASE)

CONNECT_HINT = (
    "Hints: close the KS Fit app on your phone (the pad accepts one connection at a time), "
    "do not pair the pad in bluetoothctl (`bluetoothctl remove <address>` if you did), "
    "and make sure the pad is powered on and close by."
)


class Protocol(enum.StrEnum):
    KINGSMITH = "kingsmith"
    FTMS = "ftms"


def detect_protocols(service_uuids: Iterable[str]) -> list[Protocol]:
    """Protocols the device offers, preferred first.

    FTMS is preferred when both are present: it is a published standard, while the proprietary
    protocol on newer pads may differ from what ph4-walkingpad documents. KingSmith reports
    steps though, so `--protocol kingsmith` is worth trying on a device that offers both.
    """
    uuids = {u.lower() for u in service_uuids}
    found = []
    if FTMS_SERVICE in uuids:
        found.append(Protocol.FTMS)
    if KS_SERVICE in uuids:
        found.append(Protocol.KINGSMITH)
    return found


def choose_protocol(service_uuids: Iterable[str], requested: Protocol | None = None) -> Protocol:
    offered = detect_protocols(service_uuids)
    if requested is not None:
        if requested not in offered:
            raise BackendError(f"device does not offer the {requested} service")
        return requested
    if not offered:
        raise BackendError("device offers neither FTMS (0x1826) nor the KingSmith service (0xFE00)")
    return offered[0]


# --- scanning -------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ScanResult:
    address: str
    name: str | None
    rssi: int | None
    service_uuids: tuple[str, ...] = ()
    reasons: tuple[str, ...] = ()

    @property
    def likely_pad(self) -> bool:
        return bool(self.reasons)


def classify(name: str | None, service_uuids: Iterable[str]) -> tuple[str, ...]:
    """Why a device looks like a WalkingPad (empty if it does not)."""
    reasons = []
    if name and LIKELY_NAME.search(name):
        reasons.append("name")
    offered = detect_protocols(service_uuids)
    if Protocol.KINGSMITH in offered:
        reasons.append("KingSmith service FE00")
    if Protocol.FTMS in offered:
        reasons.append("FTMS 1826")
    return tuple(reasons)


async def scan(timeout_s: float) -> list[ScanResult]:
    """Nearby BLE devices, likely WalkingPads first, then by signal strength."""
    from bleak import BleakScanner  # noqa: PLC0415  (keep bleak out of FAKE-only imports)

    try:
        found = await BleakScanner.discover(timeout=timeout_s, return_adv=True)
    except Exception as exc:  # bleak raises several types; BlueZ off is the usual one
        raise BackendError(f"scan failed: {exc}") from exc
    results = []
    for device, adv in found.values():
        name = adv.local_name or device.name
        uuids = tuple(u.lower() for u in adv.service_uuids)
        results.append(ScanResult(device.address, name, adv.rssi, uuids, classify(name, uuids)))
    results.sort(key=lambda r: (not r.likely_pad, -(r.rssi if r.rssi is not None else -999)))
    return results


# --- connecting -----------------------------------------------------------------------------

# The bits of bleak's BleakClient we use. Tests substitute a fake with the same shape.
GattClient = Any

# (address, timeout_s, on_disconnect) -> connected client. `connect_client` is the real one.
Connector = Callable[[str, float, Callable[[], None]], Awaitable[GattClient]]


async def connect_client(
    address: str, timeout_s: float, on_disconnect: Callable[[], None]
) -> GattClient:
    """Find the device by address and connect. Never pairs. Raises BackendError."""
    from bleak import BleakClient, BleakScanner  # noqa: PLC0415

    try:
        # BlueZ can only connect to devices it has seen recently, so scan for it first.
        device = await BleakScanner.find_device_by_address(address, timeout=timeout_s)
        if device is None:
            raise BackendError(f"{address} not found. {CONNECT_HINT}")
        client = BleakClient(
            device, disconnected_callback=lambda _client: on_disconnect(), timeout=timeout_s
        )
        await client.connect()
    except BackendError:
        raise
    except Exception as exc:
        raise BackendError(f"could not connect to {address}: {exc}. {CONNECT_HINT}") from exc
    return client


def service_uuids(client: GattClient) -> list[str]:
    return [service.uuid.lower() for service in client.services]


# --- GATT dump ------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CharacteristicInfo:
    uuid: str
    handle: int
    properties: tuple[str, ...]
    description: str
    value: bytes | None = None
    error: str | None = None
    descriptors: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ServiceInfo:
    uuid: str
    description: str
    characteristics: tuple[CharacteristicInfo, ...] = ()


@dataclass(frozen=True, slots=True)
class InspectReport:
    services: tuple[ServiceInfo, ...]
    protocols: tuple[Protocol, ...]
    ftms_speed_range: SpeedRange | None = None
    notes: tuple[str, ...] = field(default=())


async def inspect(client: GattClient) -> InspectReport:
    """Dump every service and characteristic, reading the readable ones. Writes nothing."""
    services = []
    for service in client.services:
        chars = []
        for char in service.characteristics:
            value = error = None
            if "read" in char.properties:
                try:
                    value = bytes(await client.read_gatt_char(char))
                except Exception as exc:
                    error = str(exc) or type(exc).__name__
            chars.append(
                CharacteristicInfo(
                    uuid=char.uuid.lower(),
                    handle=char.handle,
                    properties=tuple(char.properties),
                    description=char.description,
                    value=value,
                    error=error,
                    descriptors=tuple(d.uuid.lower() for d in char.descriptors),
                )
            )
        services.append(ServiceInfo(service.uuid.lower(), service.description, tuple(chars)))

    uuids = [s.uuid for s in services]
    protocols = tuple(detect_protocols(uuids))
    speed_range = None
    notes = []
    if Protocol.FTMS in protocols:
        from .ftms import parse_speed_range  # noqa: PLC0415  (ftms imports this module)

        raw = next(
            (c.value for s in services for c in s.characteristics
             if c.uuid == FTMS_SPEED_RANGE_CHAR and c.value is not None),
            None,
        )
        if raw is not None:
            try:
                speed_range = parse_speed_range(raw)
            except ValueError as exc:
                notes.append(f"could not decode FTMS speed range: {exc}")
    if Protocol.KINGSMITH in protocols:
        ks_chars = {c.uuid for s in services if s.uuid == KS_SERVICE for c in s.characteristics}
        missing = {KS_NOTIFY_CHAR, KS_WRITE_CHAR} - ks_chars
        if missing:
            notes.append(f"KingSmith service lacks {sorted(missing)}; the protocol may differ")
    return InspectReport(tuple(services), protocols, speed_range, tuple(notes))


def format_value(value: bytes) -> str:
    text = value.hex(" ")
    stripped = value.rstrip(b"\x00")  # device info strings are often NUL-terminated
    if stripped and all(32 <= b < 127 for b in stripped):
        text += f'  "{stripped.decode("ascii")}"'
    return text


# --- protocol handlers ----------------------------------------------------------------------


class ProtocolHandler(ABC):
    """Speaks one pad protocol over an already connected GATT client. Read-only for now."""

    protocol: Protocol
    speed_range: SpeedRange

    @abstractmethod
    async def start(self, client: GattClient, publish: Callable[[Sample], None]) -> None:
        """Subscribe to live data; call `publish` for every decoded sample."""

    @abstractmethod
    async def stop(self) -> None:
        """Cancel background work. Must not write to the device."""
