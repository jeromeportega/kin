"""Tests for app/ics.py — RFC 5545 renderer with icalendar round-trip."""
import re
from datetime import date, datetime, timezone

import pytest
from icalendar import Calendar

from app.digest import DigestItem
from app.ics import (
    _escape_text,
    _fold_line,
    event_uid,
    render_calendar,
    render_event,
)


DTSTAMP = datetime(2026, 5, 20, 18, 0, 0, tzinfo=timezone.utc)


def _item(**overrides) -> DigestItem:
    base = dict(
        classification_id=1,
        message_id="<a@x.com>",
        uid="1",
        from_addr="s@example.com",
        subject="Hello",
        date="2026-05-20T12:00:00+00:00",
        category="daycare",
        priority="high",
        action_required=True,
        summary="A summary.",
        action_items=["Do thing"],
        dates=["2026-05-25"],
        confidence=0.9,
        model="qwen3:14b",
        prompt_version="abc",
        classified_at="2026-05-20T18:00:00+00:00",
    )
    base.update(overrides)
    return DigestItem(**base)


# --- event_uid --------------------------------------------------------------

def test_event_uid_deterministic():
    assert event_uid("<a@x.com>", "2026-05-25") == event_uid("<a@x.com>", "2026-05-25")


def test_event_uid_differs_by_date():
    a = event_uid("<a@x.com>", "2026-05-25")
    b = event_uid("<a@x.com>", "2026-05-26")
    assert a != b


def test_event_uid_differs_by_message_id():
    a = event_uid("<a@x.com>", "2026-05-25")
    b = event_uid("<b@x.com>", "2026-05-25")
    assert a != b


def test_event_uid_shape():
    val = event_uid("<a@x.com>", "2026-05-25")
    assert val.endswith("@kin.local")
    head = val.split("@")[0]
    assert re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", head)


# --- _escape_text -----------------------------------------------------------

def test_escape_backslash_first():
    assert _escape_text("\\") == "\\\\"


def test_escape_semicolon():
    assert _escape_text("a;b") == "a\\;b"


def test_escape_comma():
    assert _escape_text("a,b") == "a\\,b"


def test_escape_newline():
    assert _escape_text("a\nb") == "a\\nb"


def test_escape_combined_order_safe():
    # If backslash were escaped last, the slashes inserted by the other
    # escapes would themselves get escaped.
    assert _escape_text("a\\;b,c\nd") == "a\\\\\\;b\\,c\\nd"


# --- _fold_line -------------------------------------------------------------

def test_fold_line_short_unchanged():
    assert _fold_line("short line") == "short line"


def test_fold_line_long_folds_with_crlf_space():
    long = "x" * 200
    folded = _fold_line(long)
    assert "\r\n " in folded
    # Every physical line stays under 75 octets.
    for ln in folded.split("\r\n"):
        assert len(ln.encode("utf-8")) <= 75


def test_fold_line_never_splits_mid_codepoint():
    # Put a 4-byte emoji where naive byte-splitting would land mid-character.
    line = "x" * 73 + "🎉" + "y" * 100
    folded = _fold_line(line)
    for ln in folded.split("\r\n"):
        ln.encode("utf-8").decode("utf-8")  # must round-trip
    # Total content is preserved
    rejoined = folded.replace("\r\n ", "")
    assert rejoined == line


# --- render_event -----------------------------------------------------------

def test_render_event_contains_required_lines():
    s = render_event(_item(), "2026-05-25", DTSTAMP)
    assert "BEGIN:VEVENT" in s
    assert "END:VEVENT" in s
    assert "UID:" in s
    assert "DTSTAMP:20260520T180000Z" in s
    assert "DTSTART;VALUE=DATE:20260525" in s
    assert "DTEND;VALUE=DATE:20260526" in s
    assert "SEQUENCE:0" in s
    assert "STATUS:CONFIRMED" in s
    assert "TRANSP:TRANSPARENT" in s


def test_render_event_dtend_is_day_after_dtstart():
    s = render_event(_item(), "2026-05-31", DTSTAMP)
    assert "DTSTART;VALUE=DATE:20260531" in s
    assert "DTEND;VALUE=DATE:20260601" in s


def test_render_event_uses_crlf_not_bare_lf():
    s = render_event(_item(), "2026-05-25", DTSTAMP)
    assert "\r\n" in s
    raw_lf = re.findall(r"(?<!\r)\n", s)
    assert raw_lf == []


def test_render_event_rejects_naive_dtstamp():
    with pytest.raises(ValueError, match="tz-aware"):
        render_event(_item(), "2026-05-25", datetime(2026, 5, 20, 18, 0, 0))


# --- render_calendar --------------------------------------------------------

def test_render_calendar_empty():
    s = render_calendar([], DTSTAMP)
    assert "BEGIN:VCALENDAR" in s
    assert "END:VCALENDAR" in s
    assert "BEGIN:VEVENT" not in s


def test_render_calendar_one_event_per_date():
    item = _item(dates=["2026-05-25", "2026-05-30"])
    s = render_calendar([item], DTSTAMP)
    assert s.count("BEGIN:VEVENT") == 2


def test_render_calendar_items_without_dates_produce_no_events():
    s = render_calendar([_item(dates=[])], DTSTAMP)
    assert "BEGIN:VEVENT" not in s


def test_render_calendar_ends_with_crlf():
    s = render_calendar([_item()], DTSTAMP)
    assert s.endswith("\r\n")


# --- icalendar round-trip (RFC compliance) ---------------------------------

def test_icalendar_parses_basic_calendar():
    s = render_calendar([_item()], DTSTAMP)
    cal = Calendar.from_ical(s)
    events = [c for c in cal.walk() if c.name == "VEVENT"]
    assert len(events) == 1


def test_icalendar_preserves_sequence_status_transp():
    s = render_calendar([_item()], DTSTAMP)
    cal = Calendar.from_ical(s)
    ev = [c for c in cal.walk() if c.name == "VEVENT"][0]
    assert int(ev["SEQUENCE"]) == 0
    assert str(ev["STATUS"]) == "CONFIRMED"
    assert str(ev["TRANSP"]) == "TRANSPARENT"


def test_icalendar_unescapes_subject_with_special_chars():
    item = _item(subject="Tricky; sub, with chars")
    s = render_calendar([item], DTSTAMP)
    cal = Calendar.from_ical(s)
    ev = [c for c in cal.walk() if c.name == "VEVENT"][0]
    assert str(ev["SUMMARY"]) == "Tricky; sub, with chars"


def test_icalendar_round_trips_description_with_newlines():
    item = _item(summary="Line1\nLine2; with comma, and \\ backslash")
    s = render_calendar([item], DTSTAMP)
    cal = Calendar.from_ical(s)
    ev = [c for c in cal.walk() if c.name == "VEVENT"][0]
    desc = str(ev["DESCRIPTION"])
    assert "Line1\nLine2; with comma, and \\ backslash" in desc


def test_icalendar_handles_emoji_subject():
    item = _item(subject="🎉 Celebration day")
    s = render_calendar([item], DTSTAMP)
    cal = Calendar.from_ical(s)
    ev = [c for c in cal.walk() if c.name == "VEVENT"][0]
    assert str(ev["SUMMARY"]) == "🎉 Celebration day"


def test_icalendar_dtstart_is_a_date_for_all_day():
    s = render_calendar([_item()], DTSTAMP)
    cal = Calendar.from_ical(s)
    ev = [c for c in cal.walk() if c.name == "VEVENT"][0]
    dt = ev["DTSTART"].dt
    assert isinstance(dt, date) and not isinstance(dt, datetime)


def test_icalendar_uids_unique_per_event():
    item = _item(dates=["2026-05-25", "2026-05-30"])
    s = render_calendar([item], DTSTAMP)
    cal = Calendar.from_ical(s)
    uids = [str(e["UID"]) for e in cal.walk() if e.name == "VEVENT"]
    assert len(set(uids)) == 2


def test_icalendar_round_trips_long_description():
    item = _item(summary="x" * 300, action_items=[])
    s = render_calendar([item], DTSTAMP)
    cal = Calendar.from_ical(s)
    ev = [c for c in cal.walk() if c.name == "VEVENT"][0]
    assert "x" * 300 in str(ev["DESCRIPTION"])
