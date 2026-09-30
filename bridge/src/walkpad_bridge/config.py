"""Bridge config, loaded from bridge/config.toml (override the path with WALKPAD_CONFIG)."""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field, fields
from pathlib import Path

from .safety import SafetyConfig

DEFAULT_PATH = Path(__file__).resolve().parents[2] / "config.toml"


@dataclass(frozen=True, slots=True)
class Config:
    safety: SafetyConfig = field(default_factory=SafetyConfig)


def load_config(path: Path | None = None) -> Config:
    """Load config. Missing file means defaults; unknown keys are an error (catches typos)."""
    if path is None:
        env = os.environ.get("WALKPAD_CONFIG")
        path = Path(env) if env else DEFAULT_PATH
        if not path.exists() and not env:
            return Config()
    with path.open("rb") as f:
        data = tomllib.load(f)

    unknown_sections = set(data) - {"safety"}
    if unknown_sections:
        raise ValueError(f"{path}: unknown config sections {sorted(unknown_sections)}")
    safety = data.get("safety", {})
    allowed = {f.name for f in fields(SafetyConfig)}
    unknown_keys = set(safety) - allowed
    if unknown_keys:
        raise ValueError(f"{path}: unknown [safety] keys {sorted(unknown_keys)}")
    return Config(safety=SafetyConfig(**safety))
