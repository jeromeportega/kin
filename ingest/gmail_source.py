"""Gmail-backed EmailSource for kin ingestion.

Fetches recent INBOX messages via the Gmail REST API, mapping each to the
shared FetchedEmail shape.  Re-declares its own truncation and HTML-strip
logic (ADR-006) rather than importing imap_source, which would pull
imap_tools into this environment.
"""
import base64
import logging
import re
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Iterator

import google.oauth2.credentials
from googleapiclient.discovery import build

from app.email_source import EmailSource, FetchedEmail

logger = logging.getLogger(__name__)

MAX_BODY_CHARS = 4000

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")


def _strip_html(html: str) -> str:
    text = _HTML_TAG_RE.sub(" ", html)
    return _WHITESPACE_RE.sub(" ", text).strip()


def _decode_b64url(data: str) -> str:
    """Decode a URL-safe base64 string (Gmail omits padding)."""
    rem = len(data) % 4
    if rem:
        data += "=" * (4 - rem)
    return base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")


def _extract_parts(payload: dict) -> tuple[str, str]:
    """Recursively walk a Gmail payload and return (plain_text, html_text)."""
    mime = payload.get("mimeType", "")
    if mime == "text/plain":
        raw = payload.get("body", {}).get("data", "")
        return (_decode_b64url(raw) if raw else ""), ""
    if mime == "text/html":
        raw = payload.get("body", {}).get("data", "")
        return "", (_decode_b64url(raw) if raw else "")

    plain = html = ""
    for part in payload.get("parts", []):
        p, h = _extract_parts(part)
        if not plain and p:
            plain = p
        if not html and h:
            html = h
    return plain, html


def _header(headers: list[dict], name: str) -> str:
    name_lc = name.lower()
    for h in headers:
        if h["name"].lower() == name_lc:
            return h["value"]
    return ""


def _parse_addrs(raw: str) -> tuple[str, ...]:
    if not raw:
        return ()
    return tuple(a.strip() for a in raw.split(",") if a.strip())


def _parse_date(raw: str, internal_ms: str = "") -> datetime:
    """Parse the Date header (RFC 2822) to a tz-aware datetime."""
    if raw:
        try:
            dt = parsedate_to_datetime(raw)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except Exception:
            pass
    if internal_ms:
        try:
            return datetime.fromtimestamp(int(internal_ms) / 1000, tz=timezone.utc)
        except (ValueError, OSError):
            pass
    return datetime.now(timezone.utc)


def _to_gmail_fetched(msg: dict) -> FetchedEmail:
    """Map a Gmail API `get(format='full')` response to FetchedEmail."""
    payload = msg.get("payload", {})
    headers = payload.get("headers", [])
    msg_id = msg["id"]

    plain, html = _extract_parts(payload)
    raw_body = plain or _strip_html(html)

    if len(raw_body) > MAX_BODY_CHARS:
        text_body = raw_body[:MAX_BODY_CHARS]
        truncated = True
    else:
        text_body = raw_body
        truncated = False

    message_id = _header(headers, "Message-ID").strip()
    if not message_id:
        message_id = f"<gmail-{msg_id}@mail.gmail.com>"

    return FetchedEmail(
        uid=msg_id,
        message_id=message_id,
        from_addr=_header(headers, "From").lower(),
        to_addrs=_parse_addrs(_header(headers, "To")),
        cc_addrs=_parse_addrs(_header(headers, "Cc")),
        subject=_header(headers, "Subject"),
        date=_parse_date(_header(headers, "Date"), msg.get("internalDate", "")),
        text_body=text_body,
        truncated=truncated,
    )


class GmailSource:
    """EmailSource backed by the Gmail REST API."""

    def __init__(
        self,
        credentials: google.oauth2.credentials.Credentials,
        *,
        folder: str = "INBOX",
        _service=None,
    ) -> None:
        self._folder = folder
        self._service = (
            _service if _service is not None
            else build("gmail", "v1", credentials=credentials)
        )

    def fetch_recent(self, hours: int, limit: int) -> Iterator[FetchedEmail]:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        epoch = int(cutoff.timestamp())

        result = (
            self._service.users()
            .messages()
            .list(
                userId="me",
                labelIds=["INBOX"],
                q=f"after:{epoch}",
                maxResults=limit,
            )
            .execute()
        )

        for msg_ref in result.get("messages", []):
            full_msg = (
                self._service.users()
                .messages()
                .get(userId="me", id=msg_ref["id"], format="full")
                .execute()
            )
            yield _to_gmail_fetched(full_msg)
