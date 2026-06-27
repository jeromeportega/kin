"""Shared fixtures for the ingest test suite."""
import base64
import json
from pathlib import Path

import pytest


def _b64url(text: str) -> str:
    """Encode text as URL-safe base64 without padding (Gmail format)."""
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


def make_gmail_message(
    *,
    msg_id: str = "abc123",
    subject: str = "Test Subject",
    from_addr: str = "Alice <alice@example.com>",
    to: str = "bob@example.com",
    cc: str = "",
    date: str = "Thu, 26 Jun 2026 12:00:00 +0000",
    message_id_header: str = "<test@example.com>",
    plain_body: str = "Hello world",
    html_body: str = "",
    internal_date: str = "1750939200000",
) -> dict:
    """Build a fake Gmail API get(format='full') response dict."""
    headers = [
        {"name": "Subject", "value": subject},
        {"name": "From", "value": from_addr},
        {"name": "To", "value": to},
        {"name": "Date", "value": date},
    ]
    if message_id_header:
        headers.append({"name": "Message-ID", "value": message_id_header})
    if cc:
        headers.append({"name": "Cc", "value": cc})

    if plain_body and html_body:
        payload = {
            "mimeType": "multipart/alternative",
            "headers": headers,
            "parts": [
                {
                    "mimeType": "text/plain",
                    "body": {"data": _b64url(plain_body)},
                },
                {
                    "mimeType": "text/html",
                    "body": {"data": _b64url(html_body)},
                },
            ],
        }
    elif html_body:
        payload = {
            "mimeType": "text/html",
            "headers": headers,
            "body": {"data": _b64url(html_body)},
        }
    else:
        payload = {
            "mimeType": "text/plain",
            "headers": headers,
            "body": {"data": _b64url(plain_body)},
        }

    return {"id": msg_id, "payload": payload, "internalDate": internal_date}


@pytest.fixture
def token_store_file(tmp_path: Path) -> Path:
    """A populated token store JSON file."""
    store = tmp_path / "gmail_tokens.json"
    store.write_text(
        json.dumps({
            "alice@example.com": {
                "refresh_token": "1//0g_test_refresh",
                "scope": "https://www.googleapis.com/auth/gmail.readonly",
                "updated_at": "2026-06-26T12:00:00Z",
            }
        })
    )
    return store
