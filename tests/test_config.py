from pathlib import Path

import pytest

from app.config import FilterConfig, load_config


REPO_ROOT = Path(__file__).resolve().parent.parent


def test_example_toml_parses_into_config():
    cfg = load_config(REPO_ROOT / "kin.example.toml")
    assert isinstance(cfg, FilterConfig)
    # The example ships with a few allowlisted senders and the canonical
    # keyword list. We don't assert exact content (it's a template the
    # user edits), just that it produced something usable.
    assert len(cfg.sender_allowlist) >= 1
    assert len(cfg.subject_keywords) >= 1


def test_missing_config_raises_friendly_error(tmp_path):
    missing = tmp_path / "kin.toml"
    with pytest.raises(FileNotFoundError, match="kin.example.toml"):
        load_config(missing)


def test_empty_filters_section_yields_empty_lists(tmp_path):
    cfg_path = tmp_path / "kin.toml"
    cfg_path.write_text("[filters]\n")
    cfg = load_config(cfg_path)
    assert cfg.sender_allowlist == []
    assert cfg.subject_keywords == []


def test_missing_filters_section_is_ok(tmp_path):
    cfg_path = tmp_path / "kin.toml"
    cfg_path.write_text("")
    cfg = load_config(cfg_path)
    assert cfg.sender_allowlist == []
