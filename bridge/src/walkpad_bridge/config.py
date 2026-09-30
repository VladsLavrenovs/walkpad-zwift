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

DEFAULT_PATH = Path(__file__).resolve().parents[2] / "config.toml"


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
class Config:
    safety: SafetyConfig = field(default_factory=SafetyConfig)
    ble: BleConfig = field(default_factory=BleConfig)


SECTIONS: dict[str, Any] = {"safety": SafetyConfig, "ble": BleConfig}


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
