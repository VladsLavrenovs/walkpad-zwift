from pathlib import Path

import pytest

from walkpad_bridge.config import DEFAULT_PATH, load_config
from walkpad_bridge.safety import SafetyConfig


def test_repo_config_matches_claude_md_defaults() -> None:
    cfg = load_config(DEFAULT_PATH)
    assert cfg.safety.max_speed_kmh == 6.0
    assert cfg.safety.max_ramp_kmh_per_s == 0.5


def test_loads_safety_section(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text("[safety]\nmax_speed_kmh = 4.5\n")
    cfg = load_config(path)
    assert cfg.safety.max_speed_kmh == 4.5
    assert cfg.safety.max_ramp_kmh_per_s == SafetyConfig().max_ramp_kmh_per_s


@pytest.mark.parametrize(
    "text", ["[safety]\nmax_sped_kmh = 4.5\n", "[saftey]\n", "[safety]\nmax_speed_kmh = -1\n"]
)
def test_bad_config_rejected(tmp_path: Path, text: str) -> None:
    path = tmp_path / "config.toml"
    path.write_text(text)
    with pytest.raises(ValueError):
        load_config(path)


def test_env_var_overrides_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "custom.toml"
    path.write_text("[safety]\nmax_speed_kmh = 3.0\n")
    monkeypatch.setenv("WALKPAD_CONFIG", str(path))
    assert load_config().safety.max_speed_kmh == 3.0
