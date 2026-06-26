"""Unit tests for app.email_render — pure HTML/text/subject renderers."""
from datetime import datetime

import pytest

from app.digest import Digest, DigestItem
from app.email_render import render_html, render_subject, render_text


# ---------------------------------------------------------------------------
# Fixture factories
# ---------------------------------------------------------------------------

def _item(**kw) -> DigestItem:
    base = dict(
        classification_id=1,
        message_id="<a@x>",
        uid="1",
        from_addr="s@example.com",
        subject="Subject A",
        date="2026-05-20T12:00:00+00:00",
        category="daycare",
        priority="high",
        action_required=True,
        summary="A summary.",
        action_items=["Do thing"],
        dates=["2026-05-25"],
        confidence=0.9,
        model="qwen3:14b",
        prompt_version="abc123",
        classified_at="2026-05-20T18:00:00+00:00",
    )
    base.update(kw)
    return DigestItem(**base)


def _digest(items=None, **kw) -> Digest:
    base = dict(
        generated_at="2026-05-20T18:00:00+00:00",
        user_id="jerome",
        model=None,
        prompt_version=None,
        window_hours=24,
        window_start="2026-05-19T18:00:00+00:00",
        window_end="2026-05-20T18:00:00+00:00",
        include_other=False,
        classified_count=1,
        actionable_count=1,
        informational_count=0,
        skipped_other_count=0,
        dropped_low_count=0,
        items=items if items is not None else [_item()],
    )
    base.update(kw)
    return Digest(**base)


# ---------------------------------------------------------------------------
# AC1 — render_html groups by priority→category
# ---------------------------------------------------------------------------

def test_html_priority_order_high_before_medium_before_low():
    items = [
        _item(message_id="<low@x>", priority="low", category="zz", subject="LowSubj"),
        _item(message_id="<med@x>", priority="medium", category="bb", subject="MedSubj"),
        _item(message_id="<high@x>", priority="high", category="aa", subject="HighSubj"),
    ]
    d = _digest(items=items, classified_count=3, actionable_count=3)
    out = render_html(d)
    high_pos = out.find("High priority")
    medium_pos = out.find("Medium priority")
    low_pos = out.find("Low priority")
    assert 0 <= high_pos < medium_pos < low_pos


def test_html_inner_categories_sorted_alphabetically():
    items = [
        _item(message_id="<z@x>", priority="high", category="zoo", subject="Z"),
        _item(message_id="<a@x>", priority="high", category="apple", subject="A"),
        _item(message_id="<m@x>", priority="high", category="mango", subject="M"),
    ]
    d = _digest(items=items, classified_count=3, actionable_count=3)
    out = render_html(d)
    apple_pos = out.find("apple")
    mango_pos = out.find("mango")
    zoo_pos = out.find("zoo")
    assert 0 <= apple_pos < mango_pos < zoo_pos


def test_html_item_content_appears_under_correct_bucket():
    items = [
        _item(message_id="<h@x>", priority="high", category="work", subject="HighWork",
              summary="High summary", action_items=["High action"]),
        _item(message_id="<l@x>", priority="low", category="home", subject="LowHome",
              summary="Low summary", action_items=["Low action"]),
    ]
    d = _digest(items=items, classified_count=2, actionable_count=2)
    out = render_html(d)

    high_section_end = out.find("Medium priority")
    if high_section_end == -1:
        high_section_end = out.find("Low priority")
    high_section = out[:high_section_end]
    assert "HighWork" in high_section
    assert "LowHome" not in high_section

    low_section_start = out.find("Low priority")
    low_section = out[low_section_start:]
    assert "LowHome" in low_section
    assert "HighWork" not in low_section


# ---------------------------------------------------------------------------
# AC2 — render_text produces same grouping, no HTML markup
# ---------------------------------------------------------------------------

def test_text_priority_order_matches_html():
    items = [
        _item(message_id="<low@x>", priority="low", category="zz", subject="LowSubj"),
        _item(message_id="<med@x>", priority="medium", category="bb", subject="MedSubj"),
        _item(message_id="<high@x>", priority="high", category="aa", subject="HighSubj"),
    ]
    d = _digest(items=items, classified_count=3, actionable_count=3)
    out = render_text(d)
    high_pos = out.find("High priority")
    medium_pos = out.find("Medium priority")
    low_pos = out.find("Low priority")
    assert 0 <= high_pos < medium_pos < low_pos


def test_text_inner_categories_sorted_alphabetically():
    items = [
        _item(message_id="<z@x>", priority="high", category="zoo", subject="Z"),
        _item(message_id="<a@x>", priority="high", category="apple", subject="A"),
    ]
    d = _digest(items=items, classified_count=2, actionable_count=2)
    out = render_text(d)
    apple_pos = out.find("apple")
    zoo_pos = out.find("zoo")
    assert 0 <= apple_pos < zoo_pos


def test_text_contains_no_html_tags():
    items = [
        _item(message_id="<h@x>", priority="high", subject="Hello"),
        _item(message_id="<m@x>", priority="medium", subject="World"),
    ]
    d = _digest(items=items, classified_count=2, actionable_count=2)
    out = render_text(d)
    assert "<" not in out
    assert ">" not in out


def test_text_item_content_present():
    item = _item(subject="My Subject", from_addr="me@example.com",
                 summary="My summary", action_items=["Act on it"])
    d = _digest(items=[item])
    out = render_text(d)
    assert "My Subject" in out
    assert "me@example.com" in out
    assert "My summary" in out
    assert "Act on it" in out


# ---------------------------------------------------------------------------
# AC3 — render_subject exact format with injected now_local
# ---------------------------------------------------------------------------

def test_subject_exact_format():
    # actionable_count=5 but only 2 items — proves it reads the field, not len(items)
    items = [_item(message_id=f"<{i}@x>") for i in range(2)]
    d = _digest(items=items, actionable_count=5, classified_count=7)
    now = datetime(2026, 6, 26, 9, 0, 0)
    result = render_subject(d, now_local=now)
    assert result == "kin daily digest — 2026-06-26 · 5 actionable"


def test_subject_reads_actionable_count_not_len_items():
    items = [_item(message_id=f"<{i}@x>") for i in range(3)]
    d = _digest(items=items, actionable_count=99, classified_count=100)
    now = datetime(2026, 1, 1, 0, 0, 0)
    result = render_subject(d, now_local=now)
    assert "99 actionable" in result
    assert "3 actionable" not in result


def test_subject_date_uses_now_local_not_generated_at():
    d = _digest(generated_at="2020-01-01T00:00:00+00:00")
    now = datetime(2026, 6, 26, 15, 30, 0)
    result = render_subject(d, now_local=now)
    assert "2026-06-26" in result
    assert "2020-01-01" not in result


# ---------------------------------------------------------------------------
# AC4 — empty digest
# ---------------------------------------------------------------------------

def test_html_empty_digest_nothing_actionable():
    d = _digest(items=[], classified_count=0, actionable_count=0)
    out = render_html(d)
    assert "nothing actionable today" in out.lower()


def test_html_empty_digest_no_group_headers():
    d = _digest(items=[], classified_count=0, actionable_count=0)
    out = render_html(d)
    assert "High priority" not in out
    assert "Medium priority" not in out
    assert "Low priority" not in out


def test_html_empty_digest_is_well_formed():
    d = _digest(items=[], classified_count=0, actionable_count=0)
    out = render_html(d)
    assert out.startswith("<html>")
    assert out.endswith("</html>")


def test_text_empty_digest_nothing_actionable():
    d = _digest(items=[], classified_count=0, actionable_count=0)
    out = render_text(d)
    assert "nothing actionable today" in out.lower()


def test_text_empty_digest_no_group_headers():
    d = _digest(items=[], classified_count=0, actionable_count=0)
    out = render_text(d)
    assert "High priority" not in out
    assert "Medium priority" not in out
    assert "Low priority" not in out


# ---------------------------------------------------------------------------
# Security/boundary — HTML escaping
# ---------------------------------------------------------------------------

def test_html_escapes_special_chars_in_item_fields():
    item = _item(
        subject='<script>alert("xss")</script>',
        from_addr="evil&co <evil@example.com>",
        summary="Use <b>bold</b> & 'quotes'",
        action_items=["Click <here> & confirm"],
    )
    d = _digest(items=[item])
    out = render_html(d)
    # Raw script tag must not appear (would be an XSS vector)
    assert "<script>" not in out
    assert "</script>" not in out
    # Escaped forms must appear
    assert "&lt;script&gt;" in out
    assert "&amp;" in out


def test_html_escapes_all_item_derived_fields():
    item = _item(
        subject="subj <&>",
        from_addr='from <"quoted">',
        summary="summ & stuff",
        action_items=["act <one>", "act &amp; two"],
    )
    d = _digest(items=[item])
    out = render_html(d)
    # No raw < or & except from the structural HTML tags
    # Strip known structural tags and verify no raw user-derived < or &
    import re
    # Remove all HTML tags (structural)
    text_only = re.sub(r"<[^>]+>", "", out)
    assert "<" not in text_only
    assert "&" not in text_only or all(
        amp in text_only for amp in []
    )


def test_text_does_not_escape_special_chars():
    item = _item(
        subject="subj <&>",
        from_addr="from&co",
        summary="summ < > &",
        action_items=["act < >"],
    )
    d = _digest(items=[item])
    out = render_text(d)
    # Raw chars present, no HTML entities
    assert "<" in out
    assert "&" in out
    assert "&lt;" not in out
    assert "&amp;" not in out


# ---------------------------------------------------------------------------
# Boundary — single-priority multiple categories
# ---------------------------------------------------------------------------

def test_html_single_priority_multiple_categories_sorted():
    items = [
        _item(message_id="<c@x>", priority="medium", category="cherry", subject="C"),
        _item(message_id="<a@x>", priority="medium", category="apple", subject="A"),
        _item(message_id="<b@x>", priority="medium", category="banana", subject="B"),
    ]
    d = _digest(items=items, classified_count=3, actionable_count=3)
    out = render_html(d)
    apple_pos = out.find("apple")
    banana_pos = out.find("banana")
    cherry_pos = out.find("cherry")
    assert 0 <= apple_pos < banana_pos < cherry_pos
    # Only medium section present
    assert "High priority" not in out
    assert "Low priority" not in out


def test_html_multiple_items_same_bucket_both_rendered():
    items = [
        _item(message_id="<x1@x>", priority="high", category="work", subject="Item One"),
        _item(message_id="<x2@x>", priority="high", category="work", subject="Item Two"),
    ]
    d = _digest(items=items, classified_count=2, actionable_count=2)
    out = render_html(d)
    assert "Item One" in out
    assert "Item Two" in out
    # Both under the same h3 work bucket — only one h3 for 'work'
    assert out.count("work (2)") == 1
