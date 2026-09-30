"""Bridge config, loaded from bridge/config.toml (override the path with WALKPAD_CONFIG)."""

from __future__ import annotations

import math
import os
import tomllib
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

from .ble import Protocol
from .safety import SafetyConfig

BRIDGE_DIR = Path(__file__).resolve().parents[2]
DEFAULT_PATH = BRIDGE_DIR / "config.toml"


def _positive(section: str, obj: object, *names: str) -> None:
    for name in names:
        value = getattr(obj, name)
        if not (math.isfinite(value) and value > 0):
            raise ValueError(f"{section}.{name} must be a positive number, got {value!r}")


def _port(section: str, value: int) -> None:
    if not 0 < value < 65536:
        raise ValueError(f"{section} port must be 1-65535, got {value!r}")


@dataclass(frozen=True, slots=True)
class BleConfig:
    address: str = ""  # default pad address for `live`/`inspect` (empty: pass it on the CLI)
    protocol: str = "auto"  # auto | kingsmith | ftms
    scan_timeout_s: float = 8.0
    connect_timeout_s: float = 20.0
    kingsmith_poll_s: float = 1.0

    def __post_init__(self) -> None:
        if self.protocol != "auto" and self.protocol not in set(Protocol):
            raise ValueError(f"ble.protocol must be auto, kingsmith or ftms, got {self.protocol!r}")
        for name in ("scan_timeout_s", "connect_timeout_s"):
            value = getattr(self, name)
            if not (math.isfinite(value) and value > 0):
                raise ValueError(f"ble.{name} must be a positive number, got {value!r}")
        if not self.kingsmith_poll_s >= 0.5:
            raise ValueError("ble.kingsmith_poll_s must be at least 0.5")

    @property
    def protocol_or_none(self) -> Protocol | None:
        return None if self.protocol == "auto" else Protocol(self.protocol)


@dataclass(frozen=True, slots=True)
class ServerConfig:
    host: str = "0.0.0.0"  # LAN; control is still limited to localhost/LAN clients
    port: int = 8080
    web_dist: str = "../web/dist"  # built web app, relative to bridge/
    # Belt control from outside localhost/LAN (e.g. through the Cloudflare Tunnel). Off per CLAUDE.md.
    allow_remote_control: bool = False
    # Extra Host names allowed for control requests (IP literals, localhost and this machine's
    # hostname are always allowed). Guards against DNS rebinding.
    control_hosts: tuple[str, ...] = ()
    # Origins allowed to read (GET, WebSocket) cross-origin, e.g. the deployed web app.
    cors_origins: tuple[str, ...] = ("https://walk.connectedovals.com",)
    # Controlling client gone: wait this long for it to reconnect, then ramp down and stop.
    client_grace_s: float = 5.0
    reconnect_interval_s: float = 5.0  # pad unreachable: retry this often

    def __post_init__(self) -> None:
        object.__setattr__(self, "control_hosts", tuple(self.control_hosts))
        object.__setattr__(self, "cors_origins", tuple(self.cors_origins))
        _positive("server", self, "client_grace_s", "reconnect_interval_s")
        _port("server", self.port)

    def web_dist_path(self) -> Path:
        return (BRIDGE_DIR / self.web_dist).resolve()


@dataclass(frozen=True, slots=True)
class StorageConfig:
    db_path: str = "data/walkpad.sqlite"  # relative to bridge/
    min_session_s: float = 10.0  # shorter sessions (e.g. a start/stop test) are discarded

    def __post_init__(self) -> None:
        if self.min_session_s < 0:
            raise ValueError("storage.min_session_s must not be negative")

    def db_file(self) -> Path:
        return (BRIDGE_DIR / self.db_path).resolve()


@dataclass(frozen=True, slots=True)
class UdpConfig:
    enabled: bool = False
    host: str = ""  # e.g. the Windows PC running the game receiver
    port: int = 5005

    def __post_init__(self) -> None:
        _port("udp", self.port)
        if self.enabled and not self.host:
            raise ValueError("udp.host must be set when udp.enabled is true")


@dataclass(frozen=True, slots=True)
class Config:
    safety: SafetyConfig = field(default_factory=SafetyConfig)
    ble: BleConfig = field(default_factory=BleConfig)
    server: ServerConfig = field(default_factory=ServerConfig)
    storage: StorageConfig = field(default_factory=StorageConfig)
    udp: UdpConfig = field(default_factory=UdpConfig)


SECTIONS: dict[str, Any] = {
    "safety": SafetyConfig,
    "ble": BleConfig,
    "server": ServerConfig,
    "storage": StorageConfig,
    "udp": UdpConfig,
}


def load_config(path: Path | None = None) -> Config:
    """Load config. Missing file means defaults; unknown keys are an error (catches typos)."""
    if path is None:
        env = os.environ.get("WALKPAD_CONFIG")
        path = Path(env) if env else DEFAULT_PATH
        if not path.exists() and not env:
            return Config()
    with path.open("rb") as f:
        data = tomllib.load(f)

    unknown_sections = set(data) - set(SECTIONS)
    if unknown_sections:
        raise ValueError(f"{path}: unknown config sections {sorted(unknown_sections)}")
    sections = {}
    for name, cls in SECTIONS.items():
        values = data.get(name, {})
        unknown_keys = set(values) - {f.name for f in fields(cls)}
        if unknown_keys:
            raise ValueError(f"{path}: unknown [{name}] keys {sorted(unknown_keys)}")
        sections[name] = cls(**values)
    return Config(**sections)
