"""RFC 5545 iCalendar (ICS) renderer — pure functions, stdlib only.

Renders one VEVENT per `(item, date)` pair across digest items. UIDs are
UUID5-derived from `(message_id, date)`, so re-imports update existing
events rather than duplicating. Line folding is octet-based on UTF-8 to
handle non-ASCII subjects without corrupting codepoints.

Compliance specifics:
- CRLF line endings everywhere (Apple Calendar / Outlook reject bare LF).
- Folding at 75 octets, split between codepoints only.
- TEXT-property escape order: backslash → `;` → `,` → newline.
- DTEND is exclusive for VALUE=DATE all-day events.
- SEQUENCE:0, STATUS:CONFIRMED, TRANSP:TRANSPARENT on every event.
"""
import re
import uuid
from datetime import date, datetime, timezone
from typing import Iterable

from app.digest import DigestItem
from app.obsidian import KIN_UUID_NAMESPACE

CRLF = "\r\n"


# ----------------------------------------------------------------------------
# TEXT escape
# ----------------------------------------------------------------------------

def _escape_text(s: str) -> str:
    """RFC 5545 TEXT-property escape. Backslash must come first or you
    double-escape every other character."""
    return (
        s.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\n", "\\n")
    )


# ----------------------------------------------------------------------------
# Line folding (octet-based)
# ----------------------------------------------------------------------------

def _fold_line(line: str) -> str:
    """Fold a content line at 75 octets per RFC 5545.

    Splits at UTF-8 codepoint boundaries; never produces invalid UTF-8.
    Continuation lines are prefixed with a single space.
    """
    encoded = line.encode("utf-8")
    if len(encoded) <= 75:
        return line

    chunks: list[str] = []
    cursor = 0
    while cursor < len(encoded):
        # First chunk gets the full 75 octets; continuations use 74 to
        # account for the leading space the folder will add.
        max_take = 75 if cursor == 0 else 74
        end = min(cursor + max_take, len(encoded))
        # Walk back if we'd land mid-codepoint (continuation byte starts with 10xxxxxx).
        while end < len(encoded) and (encoded[end] & 0xC0) == 0x80:
            end -= 1
        chunks.append(encoded[cursor:end].decode("utf-8"))
        cursor = end

    return chunks[0] + "".join(CRLF + " " + c for c in chunks[1:])


# ----------------------------------------------------------------------------
# UIDs
# ----------------------------------------------------------------------------

def event_uid(message_id: str, date_str: str) -> str:
    """UUID5-based stable UID: `<uuid>@kin.local`.

    Identical (message_id, date) inputs always produce the same UID, so a
    re-imported calendar updates existing events rather than duplicating.
    """
    composite = f"{message_id}::{date_str}"
    return f"{uuid.uuid5(KIN_UUID_NAMESPACE, composite)}@kin.local"


# ----------------------------------------------------------------------------
# Format helpers
# ----------------------------------------------------------------------------

def _format_dtstamp(dt: datetime) -> str:
    """RFC 5545 DTSTAMP form: `YYYYMMDDTHHMMSSZ` (UTC)."""
    if dt.tzinfo is None:
        raise ValueError("DTSTAMP datetime must be tz-aware")
    return dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _format_date(d: date) -> str:
    """RFC 5545 VALUE=DATE form: `YYYYMMDD`."""
    return d.strftime("%Y%m%d")


def _parse_iso_date(s: str) -> date:
    """Parse a YYYY-MM-DD or ISO 8601 datetime string into a date."""
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return date.fromisoformat(s)
    return datetime.fromisoformat(s).date()


# ----------------------------------------------------------------------------
# VEVENT / VCALENDAR rendering
# ----------------------------------------------------------------------------

def render_event(item: DigestItem, date_str: str, dtstamp: datetime) -> str:
    """Render a single VEVENT block for the (item, date_str) pair.

    Returns the block as a CRLF-joined string without a trailing CRLF.
    """
    event_date = _parse_iso_date(date_str)
    next_day = date.fromordinal(event_date.toordinal() + 1)

    summary = item.subject or "(no subject)"
    description_parts = [f"From {item.from_addr}"]
    description_parts.append(
        f"Classified {item.category}/{item.priority}/"
        f"{'actionable' if item.action_required else 'fyi'}"
    )
    if item.summary:
        description_parts.append(item.summary)
    for action in item.action_items:
        description_parts.append(f"Action: {action}")
    description = "\n".join(description_parts)

    lines = [
        "BEGIN:VEVENT",
        _fold_line(f"UID:{event_uid(item.message_id, date_str)}"),
        f"DTSTAMP:{_format_dtstamp(dtstamp)}",
        f"DTSTART;VALUE=DATE:{_format_date(event_date)}",
        f"DTEND;VALUE=DATE:{_format_date(next_day)}",
        _fold_line(f"SUMMARY:{_escape_text(summary)}"),
        _fold_line(f"DESCRIPTION:{_escape_text(description)}"),
        _fold_line(f"CATEGORIES:{_escape_text(item.category)}"),
        "SEQUENCE:0",
        "STATUS:CONFIRMED",
        "TRANSP:TRANSPARENT",
        "END:VEVENT",
    ]
    return CRLF.join(lines)


def render_calendar(items: Iterable[DigestItem], dtstamp: datetime) -> str:
    """Render a full VCALENDAR with one VEVENT per (item, date) pair."""
    parts = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//kin//Daily Digest//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
    ]
    for item in items:
        for date_str in item.dates:
            parts.append(render_event(item, date_str, dtstamp))
    parts.append("END:VCALENDAR")
    return CRLF.join(parts) + CRLF
