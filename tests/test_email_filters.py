from datetime import datetime

import pytest

from app.config import FilterConfig
from app.email_filters import sender_matches, should_classify, text_contains_any
from app.email_source import FetchedEmail


def _email(**overrides) -> FetchedEmail:
    defaults = dict(
        uid="1",
        message_id="<msg@example>",
        from_addr="someone@example.com",
        to_addrs=("me@example.com",),
        cc_addrs=(),
        subject="hello",
        date=datetime(2026, 5, 20, 12, 0, 0),
        text_body="body content",
        truncated=False,
    )
    defaults.update(overrides)
    return FetchedEmail(**defaults)


# --- sender_matches ----------------------------------------------------------

def test_sender_matches_exact_address():
    assert sender_matches("admin@daycare.example", ["admin@daycare.example"])


def test_sender_matches_domain_suffix():
    assert sender_matches("noreply@delta.com", ["@delta.com"])


def test_sender_matches_subdomain():
    assert sender_matches("alerts@notify.delta.com", ["@delta.com"])


def test_sender_matches_subdomain_does_not_match_unrelated_suffix():
    # @delta.com must NOT match foo@evildelta.com
    assert not sender_matches("foo@evildelta.com", ["@delta.com"])


def test_sender_matches_is_case_insensitive():
    assert sender_matches("Admin@Daycare.Example", ["admin@daycare.example"])


def test_sender_matches_rejects_unrelated():
    assert not sender_matches("rando@example.com", ["@delta.com", "ms@school.org"])


def test_sender_matches_empty_addr_is_false():
    assert not sender_matches("", ["@delta.com"])


# --- text_contains_any -------------------------------------------------------

def test_text_contains_any_case_insensitive():
    assert text_contains_any("Please pay your BILL", ["bill"])


def test_text_contains_any_empty_keywords_is_false():
    assert not text_contains_any("anything", [])


def test_text_contains_any_substring_match():
    # `appointment` substring in `reappointment`
    assert text_contains_any("got a reappointment notice", ["appointment"])


# --- should_classify ---------------------------------------------------------

def test_passes_when_sender_allowlisted_and_no_keywords():
    cfg = FilterConfig(sender_allowlist=["@delta.com"])
    assert should_classify(_email(from_addr="trip@delta.com"), cfg)


def test_passes_when_subject_keyword_hits():
    cfg = FilterConfig(subject_keywords=["appointment"])
    assert should_classify(_email(subject="appointment confirmed"), cfg)


def test_passes_when_body_keyword_hits():
    cfg = FilterConfig(body_keywords=["receipt"])
    assert should_classify(_email(text_body="here's your receipt"), cfg)


def test_drops_when_nothing_matches():
    cfg = FilterConfig(
        sender_allowlist=["@delta.com"],
        subject_keywords=["appointment"],
    )
    assert not should_classify(_email(), cfg)


def test_blocklist_vetoes_even_when_allowlisted():
    cfg = FilterConfig(
        sender_allowlist=["@delta.com"],
        sender_blocklist=["promo@delta.com"],
    )
    assert not should_classify(_email(from_addr="promo@delta.com"), cfg)


def test_blocklist_domain_suffix_vetoes():
    cfg = FilterConfig(
        sender_allowlist=["@school.org"],
        sender_blocklist=["@mailchimp.com"],
    )
    assert not should_classify(
        _email(from_addr="alerts@mailchimp.com", subject="school stuff"),
        cfg,
    )


# --- normalization -----------------------------------------------------------

def test_config_normalizes_lowercase_and_strip():
    cfg = FilterConfig(
        sender_allowlist=["  Admin@Daycare.Example  "],
        subject_keywords=["  Appointment  "],
    )
    assert cfg.sender_allowlist == ["admin@daycare.example"]
    assert cfg.subject_keywords == ["appointment"]


def test_config_drops_empty_entries():
    cfg = FilterConfig(sender_allowlist=["", "   ", "real@x.com"])
    assert cfg.sender_allowlist == ["real@x.com"]
