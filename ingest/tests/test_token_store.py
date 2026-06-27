"""Tests for ingest.token_store."""
import json
from pathlib import Path

from ingest.token_store import read_refresh_token


def test_read_refresh_token_known_email(token_store_file: Path):
    token = read_refresh_token("alice@example.com", path=token_store_file)
    assert token == "1//0g_test_refresh"


def test_read_refresh_token_unknown_email_returns_none(token_store_file: Path):
    token = read_refresh_token("nobody@example.com", path=token_store_file)
    assert token is None


def test_read_refresh_token_missing_file_returns_none(tmp_path: Path):
    missing = tmp_path / "nonexistent.json"
    token = read_refresh_token("alice@example.com", path=missing)
    assert token is None


def test_read_refresh_token_entry_without_refresh_token(tmp_path: Path):
    store = tmp_path / "tokens.json"
    store.write_text(json.dumps({"user@example.com": {"scope": "..."}}))
    assert read_refresh_token("user@example.com", path=store) is None


def test_read_refresh_token_malformed_json_returns_none(tmp_path: Path):
    store = tmp_path / "tokens.json"
    store.write_text("{not valid json{{")
    assert read_refresh_token("alice@example.com", path=store) is None
