"""Tests for ingest.gmail_source — GmailSource and _to_gmail_fetched."""
from datetime import timezone
from unittest.mock import MagicMock, call

import pytest

from app.email_source import EmailSource, FetchedEmail
from ingest.gmail_source import (
    MAX_BODY_CHARS,
    GmailSource,
    _to_gmail_fetched,
)
from ingest.tests.conftest import make_gmail_message


# ---------------------------------------------------------------------------
# _to_gmail_fetched — mapping happy path
# ---------------------------------------------------------------------------

def test_mapping_uid_is_gmail_message_id():
    msg = make_gmail_message(msg_id="xyz789")
    fetched = _to_gmail_fetched(msg)
    assert fetched.uid == "xyz789"


def test_mapping_from_addr_lowercased():
    msg = make_gmail_message(from_addr="Alice <ALICE@EXAMPLE.COM>")
    fetched = _to_gmail_fetched(msg)
    assert fetched.from_addr == "alice <alice@example.com>"


def test_mapping_date_is_tz_aware():
    msg = make_gmail_message(date="Thu, 26 Jun 2026 12:00:00 +0000")
    fetched = _to_gmail_fetched(msg)
    assert fetched.date.tzinfo is not None


def test_mapping_subject_populated():
    msg = make_gmail_message(subject="Hello World")
    fetched = _to_gmail_fetched(msg)
    assert fetched.subject == "Hello World"


def test_mapping_to_and_cc_populated():
    msg = make_gmail_message(to="bob@example.com, carol@example.com", cc="dave@example.com")
    fetched = _to_gmail_fetched(msg)
    assert "bob@example.com" in fetched.to_addrs
    assert "carol@example.com" in fetched.to_addrs
    assert "dave@example.com" in fetched.cc_addrs


def test_mapping_returns_fetched_email_instance():
    msg = make_gmail_message()
    fetched = _to_gmail_fetched(msg)
    assert isinstance(fetched, FetchedEmail)


def test_mapping_to_and_cc_addrs_lowercased():
    """to_addrs and cc_addrs are lowercased, consistent with from_addr."""
    msg = make_gmail_message(to="BOB@EXAMPLE.COM", cc="CAROL@EXAMPLE.COM")
    fetched = _to_gmail_fetched(msg)
    assert "bob@example.com" in fetched.to_addrs
    assert "carol@example.com" in fetched.cc_addrs


def test_mapping_rfc5322_comma_in_display_name():
    """Display name containing a comma produces one address, not two."""
    msg = make_gmail_message(to='"Smith, John" <john@example.com>')
    fetched = _to_gmail_fetched(msg)
    # Naive comma-split would yield two broken tokens instead of one address
    assert len(fetched.to_addrs) == 1
    assert "john@example.com" in fetched.to_addrs[0]


# ---------------------------------------------------------------------------
# Body rules
# ---------------------------------------------------------------------------

def test_body_plain_preferred_over_html():
    msg = make_gmail_message(plain_body="plain text", html_body="<p>HTML text</p>")
    fetched = _to_gmail_fetched(msg)
    assert fetched.text_body == "plain text"


def test_body_html_stripped_when_no_plain():
    msg = make_gmail_message(plain_body="", html_body="<p>Hello <b>world</b></p>")
    fetched = _to_gmail_fetched(msg)
    assert "Hello" in fetched.text_body
    assert "world" in fetched.text_body
    assert "<" not in fetched.text_body


def test_body_html_entities_decoded():
    """HTML character entities are decoded in the stripped body."""
    msg = make_gmail_message(plain_body="", html_body="<p>Hello &amp; World &lt;tag&gt;</p>")
    fetched = _to_gmail_fetched(msg)
    assert "&amp;" not in fetched.text_body
    assert "&lt;" not in fetched.text_body
    assert "Hello & World <tag>" in fetched.text_body


def test_body_truncated_at_4000_chars():
    long_text = "x" * (MAX_BODY_CHARS + 500)
    msg = make_gmail_message(plain_body=long_text)
    fetched = _to_gmail_fetched(msg)
    assert len(fetched.text_body) == MAX_BODY_CHARS
    assert fetched.truncated is True


def test_body_short_not_truncated():
    msg = make_gmail_message(plain_body="short body")
    fetched = _to_gmail_fetched(msg)
    assert fetched.truncated is False
    assert fetched.text_body == "short body"


# ---------------------------------------------------------------------------
# Message-ID fallback
# ---------------------------------------------------------------------------

def test_message_id_uses_rfc822_header_when_present():
    msg = make_gmail_message(msg_id="gid1", message_id_header="<myid@domain.com>")
    fetched = _to_gmail_fetched(msg)
    assert fetched.message_id == "<myid@domain.com>"


def test_message_id_fallback_when_header_absent():
    msg = make_gmail_message(msg_id="gid1", message_id_header="")
    fetched = _to_gmail_fetched(msg)
    assert fetched.message_id == "<gmail-gid1@mail.gmail.com>"


# ---------------------------------------------------------------------------
# GmailSource — class contract
# ---------------------------------------------------------------------------

def test_gmail_source_implements_email_source():
    """GmailSource must explicitly inherit from EmailSource (declared in class header)."""
    assert EmailSource in GmailSource.__mro__


# ---------------------------------------------------------------------------
# fetch_recent contract
# ---------------------------------------------------------------------------

def _make_mock_service(messages=None, full_msg=None):
    """Return a mock Gmail service configured for list+get calls."""
    svc = MagicMock()
    msgs_resource = svc.users.return_value.messages.return_value
    msgs_resource.list.return_value.execute.return_value = {
        "messages": messages or []
    }
    if full_msg is not None:
        msgs_resource.get.return_value.execute.return_value = full_msg
    return svc


def test_fetch_recent_passes_bounded_window_and_limit(monkeypatch):
    """list() is called with after:<epoch> and maxResults=limit."""
    from datetime import datetime, timedelta, timezone as tz

    fake_service = _make_mock_service(messages=[])
    src = GmailSource.__new__(GmailSource)
    src._service = fake_service
    src._folder = "INBOX"

    list(src.fetch_recent(hours=24, limit=10))

    call_kwargs = fake_service.users.return_value.messages.return_value.list.call_args[1]
    assert call_kwargs["userId"] == "me"
    assert call_kwargs["labelIds"] == ["INBOX"]
    assert call_kwargs["maxResults"] == 10
    q = call_kwargs["q"]
    assert q.startswith("after:")
    epoch_in_q = int(q.split(":")[1])
    expected_epoch = int((datetime.now(tz.utc) - timedelta(hours=24)).timestamp())
    assert abs(epoch_in_q - expected_epoch) < 60


def test_fetch_recent_uses_folder_not_hardcoded_inbox():
    """fetch_recent passes self._folder as the labelIds, not a hardcoded 'INBOX'."""
    fake_service = _make_mock_service(messages=[])
    src = GmailSource.__new__(GmailSource)
    src._service = fake_service
    src._folder = "SENT"

    list(src.fetch_recent(hours=24, limit=10))

    call_kwargs = fake_service.users.return_value.messages.return_value.list.call_args[1]
    assert call_kwargs["labelIds"] == ["SENT"]


def test_fetch_recent_calls_get_per_message():
    """get(format='full') is called once for every listed message id."""
    full_msg = make_gmail_message(msg_id="id1")
    fake_service = _make_mock_service(
        messages=[{"id": "id1"}, {"id": "id2"}],
        full_msg=full_msg,
    )
    src = GmailSource.__new__(GmailSource)
    src._service = fake_service
    src._folder = "INBOX"

    results = list(src.fetch_recent(hours=24, limit=50))

    msgs_resource = fake_service.users.return_value.messages.return_value
    assert msgs_resource.get.call_count == 2
    get_calls = msgs_resource.get.call_args_list
    ids_fetched = {c[1]["id"] for c in get_calls}
    assert ids_fetched == {"id1", "id2"}
    for c in get_calls:
        assert c[1]["format"] == "full"
        assert c[1]["userId"] == "me"


def test_fetch_recent_yields_fetched_email_objects():
    full_msg = make_gmail_message(msg_id="m1")
    fake_service = _make_mock_service(messages=[{"id": "m1"}], full_msg=full_msg)
    src = GmailSource.__new__(GmailSource)
    src._service = fake_service
    src._folder = "INBOX"

    results = list(src.fetch_recent(hours=24, limit=50))
    assert len(results) == 1
    assert isinstance(results[0], FetchedEmail)


def test_fetch_recent_skips_404_message_and_continues():
    """If a message is deleted between list() and get(), it is skipped (not an error)."""
    from googleapiclient.errors import HttpError

    good_msg = make_gmail_message(msg_id="m2")

    svc = MagicMock()
    msgs_resource = svc.users.return_value.messages.return_value
    msgs_resource.list.return_value.execute.return_value = {
        "messages": [{"id": "m1"}, {"id": "m2"}]
    }

    mock_resp = MagicMock()
    mock_resp.status = 404
    http_404 = HttpError(resp=mock_resp, content=b"Not Found")

    # First get() raises 404, second returns the good message
    msgs_resource.get.return_value.execute.side_effect = [http_404, good_msg]

    src = GmailSource.__new__(GmailSource)
    src._service = svc
    src._folder = "INBOX"

    results = list(src.fetch_recent(hours=24, limit=50))
    assert len(results) == 1
    assert results[0].uid == "m2"


# ---------------------------------------------------------------------------
# Empty inbox
# ---------------------------------------------------------------------------

def test_empty_inbox_yields_nothing_no_error():
    fake_service = _make_mock_service(messages=[])
    src = GmailSource.__new__(GmailSource)
    src._service = fake_service
    src._folder = "INBOX"

    results = list(src.fetch_recent(hours=24, limit=50))
    assert results == []

    # get() should never be called when there are no messages
    fake_service.users.return_value.messages.return_value.get.assert_not_called()


# ---------------------------------------------------------------------------
# FetchedEmail frozen contract
# ---------------------------------------------------------------------------

def test_fetched_email_is_frozen():
    """FetchedEmail must remain frozen — mutation must raise FrozenInstanceError."""
    msg = make_gmail_message()
    fetched = _to_gmail_fetched(msg)
    with pytest.raises(Exception):
        fetched.uid = "mutated"  # type: ignore[misc]
