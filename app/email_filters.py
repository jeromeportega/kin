"""Deterministic pre-filter: decide which emails are worth the LLM's time.

Pure functions, no I/O. The orchestrator constructs `FilterConfig` and
`FetchedEmail` instances and asks `should_classify`.
"""
from app.config import FilterConfig
from app.email_source import FetchedEmail


def sender_matches(addr: str, allowlist: list[str]) -> bool:
    """True if `addr` matches an entry in `allowlist`.

    Entries are either exact addresses (`admin@example.com`) or domain
    suffixes starting with `@`. A suffix matches the named domain *and*
    any subdomain — `@example.com` matches `x@example.com` and
    `x@notify.example.com`.
    """
    addr = addr.strip().lower()
    if not addr or "@" not in addr:
        return False
    _, _, domain = addr.rpartition("@")
    for entry in allowlist:
        if entry.startswith("@"):
            target = entry[1:]
            if domain == target or domain.endswith("." + target):
                return True
        elif addr == entry:
            return True
    return False


def text_contains_any(text: str, keywords: list[str]) -> bool:
    """Case-insensitive substring match. Empty keyword list returns False."""
    if not keywords:
        return False
    lowered = text.lower()
    return any(keyword in lowered for keyword in keywords)


def should_classify(email: FetchedEmail, cfg: FilterConfig) -> bool:
    """Apply the rules in order:

    1. Blocklisted sender → drop, no further checks.
    2. Otherwise pass if sender is allowlisted, OR a configured keyword
       appears in subject or body.
    """
    if sender_matches(email.from_addr, cfg.sender_blocklist):
        return False
    if sender_matches(email.from_addr, cfg.sender_allowlist):
        return True
    if text_contains_any(email.subject, cfg.subject_keywords):
        return True
    if text_contains_any(email.text_body, cfg.body_keywords):
        return True
    return False
