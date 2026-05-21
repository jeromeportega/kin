from datetime import datetime, timezone
from types import SimpleNamespace

from app.imap_source import (
    MAX_BODY_CHARS,
    _extract_body,
    _extract_message_id,
    _to_fetched,
)


def _msg(**overrides):
    base = dict(
        text="",
        html="",
        headers={},
        uid="42",
        from_="from@example.com",
        to=("to@example.com",),
        cc=(),
        subject="subj",
        date=datetime(2026, 5, 20, 12, 0, 0, tzinfo=timezone.utc),
    )
    base.update(overrides)
    return SimpleNamespace(**base)


# --- _extract_body -----------------------------------------------------------

def test_extract_body_prefers_text_plain():
    body, truncated = _extract_body(_msg(text="hello", html="<p>HELLO</p>"))
    assert body == "hello"
    assert truncated is False


def test_extract_body_falls_back_to_stripped_html():
    body, truncated = _extract_body(_msg(text="", html="<p>Hello <b>world</b></p>"))
    assert "Hello" in body and "world" in body
    assert "<" not in body
    assert truncated is False


def test_extract_body_collapses_whitespace_in_html():
    body, _ = _extract_body(_msg(text="", html="<div>line one</div>\n\n<div>line two</div>"))
    assert body == "line one line two"


def test_extract_body_returns_empty_when_both_empty():
    body, truncated = _extract_body(_msg(text="", html=""))
    assert body == ""
    assert truncated is False


def test_extract_body_truncates_long_text():
    long_text = "x" * (MAX_BODY_CHARS + 500)
    body, truncated = _extract_body(_msg(text=long_text))
    assert len(body) == MAX_BODY_CHARS
    assert truncated is True


# --- _extract_message_id -----------------------------------------------------

def test_extract_message_id_tuple_headers():
    assert _extract_message_id(_msg(headers={"message-id": ("<abc@x>",)})) == "<abc@x>"


def test_extract_message_id_string_headers():
    assert _extract_message_id(_msg(headers={"message-id": "<abc@x>"})) == "<abc@x>"


def test_extract_message_id_synthesizes_fallback_with_uid():
    assert _extract_message_id(_msg(uid="99", headers={})) == "<no-id-99@INBOX.kin.local>"


def test_extract_message_id_uses_folder_in_fallback():
    assert (
        _extract_message_id(_msg(uid="42", headers={}), folder="[Gmail]/Trash")
        == "<no-id-42@[Gmail]/Trash.kin.local>"
    )


def test_extract_message_id_uuid_fallback_when_uid_also_missing():
    val = _extract_message_id(_msg(uid=None, headers={}))
    assert val.startswith("<no-id-")
    assert val.endswith("@INBOX.kin.local>")
    assert len(val) > len("<no-id-@INBOX.kin.local>")


# --- _to_fetched -------------------------------------------------------------

def test_to_fetched_lowercases_sender():
    fetched = _to_fetched(_msg(text="b", from_="Admin@DAYCARE.example"))
    assert fetched.from_addr == "admin@daycare.example"


def test_to_fetched_carries_recipients_and_cc():
    fetched = _to_fetched(
        _msg(text="b", to=("a@x.com", "b@x.com"), cc=("c@x.com",))
    )
    assert fetched.to_addrs == ("a@x.com", "b@x.com")
    assert fetched.cc_addrs == ("c@x.com",)


def test_to_fetched_surfaces_truncated_flag():
    fetched = _to_fetched(_msg(text="x" * (MAX_BODY_CHARS + 1)))
    assert fetched.truncated is True
    assert len(fetched.text_body) == MAX_BODY_CHARS
