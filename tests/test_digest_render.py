"""Pure renderer tests for app.digest (markdown + JSON)."""
import json
import os
import time
from pathlib import Path

import pytest

from app.digest import Digest, DigestItem, render_json, render_markdown

GOLDEN = Path(__file__).parent / "golden"


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


# --- markdown ---------------------------------------------------------------

def test_markdown_empty_digest_renders_header_only():
    d = _digest(
        items=[],
        classified_count=0, actionable_count=0,
        informational_count=0,
    )
    md = render_markdown(d)
    assert md.startswith("# kin daily digest — ")
    assert "## 🚨 High" not in md
    assert "## Skipped" not in md


def test_markdown_high_before_medium_before_low():
    items = [
        _item(message_id="<low@x>", priority="low", subject="LowSubj"),
        _item(message_id="<med@x>", priority="medium", subject="MedSubj"),
        _item(message_id="<high@x>", priority="high", subject="HighSubj"),
    ]
    d = _digest(
        items=items,
        classified_count=3, actionable_count=3,
        informational_count=0,
    )
    md = render_markdown(d)
    high_pos = md.find("High priority")
    medium_pos = md.find("Medium priority")
    low_pos = md.find("Low priority")
    assert 0 <= high_pos < medium_pos < low_pos


def test_markdown_skipped_section_when_count_nonzero():
    d = _digest(skipped_other_count=12)
    md = render_markdown(d)
    assert "skipped as `other`" in md or "## Skipped" in md


def test_markdown_no_skipped_section_when_count_zero():
    d = _digest(skipped_other_count=0)
    md = render_markdown(d)
    assert "## Skipped" not in md


def test_markdown_escapes_backticks_and_pipes_in_subject():
    item = _item(subject="x | y `z`")
    d = _digest(items=[item])
    md = render_markdown(d)
    assert "x \\| y \\`z\\`" in md


def test_markdown_no_action_items_section_when_empty():
    item = _item(action_items=[])
    d = _digest(items=[item])
    md = render_markdown(d)
    assert "Actions:" not in md


def test_markdown_no_dates_line_when_empty():
    item = _item(dates=[])
    d = _digest(items=[item])
    md = render_markdown(d)
    assert "Dates:" not in md


# --- JSON ------------------------------------------------------------------

def test_json_round_trip():
    d = _digest()
    js = render_json(d)
    parsed = json.loads(js)
    assert parsed["user_id"] == "jerome"
    assert parsed["classified_count"] == 1
    assert parsed["items"][0]["subject"] == "Subject A"
    d2 = Digest.from_json(js)
    assert d2 == d


def test_json_with_special_chars_round_trips():
    item = _item(subject="back`tick and |pipe", summary="Don't break `me`")
    d = _digest(items=[item])
    js = render_json(d)
    d2 = Digest.from_json(js)
    assert d2.items[0].subject == "back`tick and |pipe"
    assert d2.items[0].summary == "Don't break `me`"


def test_json_keys_match_dataclass_fields():
    d = _digest()
    parsed = json.loads(render_json(d))
    assert set(parsed.keys()) == {
        "generated_at", "user_id", "model", "prompt_version",
        "window_hours", "window_start", "window_end",
        "include_other", "classified_count", "actionable_count",
        "informational_count", "skipped_other_count", "dropped_low_count",
        "items",
    }
    item = parsed["items"][0]
    assert set(item.keys()) == {
        "classification_id", "message_id", "uid", "from_addr", "subject",
        "date", "category", "priority", "action_required",
        "summary", "action_items", "dates", "confidence",
        "model", "prompt_version", "classified_at",
    }


# --- golden visual regression -----------------------------------------------

def test_golden_markdown_matches(monkeypatch):
    """Markdown rendering for a canonical fixture matches the on-disk golden.

    Forces TZ=UTC so the header timestamp is deterministic regardless of where
    the test runs. Updating the golden is one file touch: delete the file and
    re-run.
    """
    monkeypatch.setenv("TZ", "UTC")
    time.tzset()

    items = [
        _item(
            classification_id=10,
            message_id="<a@johnmuirhealth.com>",
            subject="JM Health: new message",
            from_addr="donotreply@johnmuirhealth.com",
            category="medical", priority="high", action_required=True,
            summary="A new message is waiting in MyChart.",
            action_items=["Log in to MyChart"],
            dates=[],
        ),
        _item(
            classification_id=11,
            message_id="<b@procaresoftware.com>",
            subject="Procare daily summary",
            from_addr="connect-notification@online.procaresoftware.com",
            category="daycare", priority="low", action_required=True,
            summary="Routine daily summary.",
            action_items=[],
            dates=[],
        ),
    ]
    d = _digest(
        items=items,
        classified_count=3,
        actionable_count=2,
        informational_count=0,
        skipped_other_count=1,
        dropped_low_count=0,
    )
    md = render_markdown(d)

    golden_path = GOLDEN / "digest_basic.md"
    if not golden_path.exists():
        golden_path.parent.mkdir(parents=True, exist_ok=True)
        golden_path.write_text(md)
        pytest.skip(f"Wrote initial golden file at {golden_path}")
    expected = golden_path.read_text()
    assert md == expected, (
        f"Markdown output differs from golden at {golden_path}. "
        "If intentional, rm the file and re-run to regenerate."
    )
