"""IMAP-based `EmailSource` for kin.

Reads recent messages from one or more folders without ever mutating
mailbox state (`mark_seen=False`). Default folder is `INBOX`; multi-folder
is parameterized in the constructor for forward compatibility, even
though the Phase 2 CLI never exposes anything but the default.
"""
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Iterator, Sequence

from imap_tools import AND, MailBox

from app.email_source import FetchedEmail

logger = logging.getLogger(__name__)

MAX_BODY_CHARS = 4000

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")


def _strip_html(html: str) -> str:
    text = _HTML_TAG_RE.sub(" ", html)
    return _WHITESPACE_RE.sub(" ", text).strip()


def _extract_body(msg) -> tuple[str, bool]:
    """Return (body, truncated). Prefer text/plain; fall back to stripped HTML."""
    raw = msg.text or _strip_html(msg.html or "")
    if len(raw) > MAX_BODY_CHARS:
        return raw[:MAX_BODY_CHARS], True
    return raw, False


def _extract_message_id(msg) -> str:
    raw = msg.headers.get("message-id") if msg.headers else None
    if isinstance(raw, tuple) and raw:
        return raw[0].strip()
    if isinstance(raw, str) and raw:
        return raw.strip()
    return str(msg.uid or "")


def _to_fetched(msg) -> FetchedEmail:
    text_body, truncated = _extract_body(msg)
    return FetchedEmail(
        uid=str(msg.uid) if msg.uid is not None else "",
        message_id=_extract_message_id(msg),
        from_addr=(msg.from_ or "").lower(),
        to_addrs=tuple(msg.to or ()),
        cc_addrs=tuple(msg.cc or ()),
        subject=msg.subject or "",
        date=msg.date,
        text_body=text_body,
        truncated=truncated,
    )


class IMAPSource:
    def __init__(
        self,
        host: str,
        port: int,
        user: str,
        password: str,
        folders: Sequence[str] = ("INBOX",),
    ) -> None:
        self._host = host
        self._port = port
        self._user = user
        self._password = password
        self._folders = tuple(folders) or ("INBOX",)

    def fetch_recent(self, hours: int, limit: int) -> Iterator[FetchedEmail]:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        # IMAP SINCE is date-granular; we re-filter to exact `hours` client-side.
        since_date = (cutoff - timedelta(days=1)).date()
        emitted = 0

        with MailBox(self._host, port=self._port).login(
            self._user, self._password
        ) as mailbox:
            for folder in self._folders:
                if emitted >= limit:
                    break
                mailbox.folder.set(folder)
                logger.info("fetching folder=%s since=%s", folder, since_date)
                for msg in mailbox.fetch(
                    AND(date_gte=since_date),
                    mark_seen=False,
                    bulk=True,
                    limit=limit - emitted,
                ):
                    msg_date = msg.date
                    if msg_date is not None and msg_date.tzinfo is None:
                        msg_date = msg_date.replace(tzinfo=timezone.utc)
                    if msg_date is not None and msg_date < cutoff:
                        continue
                    fetched = _to_fetched(msg)
                    if fetched.truncated:
                        logger.info(
                            "truncated body message_id=%s original_len=%d",
                            fetched.message_id,
                            len(msg.text or msg.html or ""),
                        )
                    yield fetched
                    emitted += 1
                    if emitted >= limit:
                        break
