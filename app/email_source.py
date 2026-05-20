"""Types and protocol for fetching email from any backend.

`FetchedEmail` is the internal representation `kin` passes around between
the source, the pre-filter, and the classifier. `EmailSource` is the
seam that lets us swap IMAP for Gmail API / Outlook / iCloud later
without touching the orchestrator.
"""
from dataclasses import dataclass
from datetime import datetime
from typing import Iterator, Protocol


@dataclass(frozen=True, slots=True)
class FetchedEmail:
    uid: str
    message_id: str
    from_addr: str
    to_addrs: tuple[str, ...]
    cc_addrs: tuple[str, ...]
    subject: str
    date: datetime
    text_body: str
    truncated: bool


class EmailSource(Protocol):
    def fetch_recent(self, hours: int, limit: int) -> Iterator[FetchedEmail]: ...
