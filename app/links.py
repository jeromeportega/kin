"""Replace inline links in email text with numbered [n] markers, returning the
markers' URLs by index. The classifier picks a marker index; we resolve it to the
exact URL — so the model never has to transcribe a long URL.

The eval cases store links in the pipeline's rendered form: `label ( https://... )`.
This mirrors what the TS ingest does from HTML `<a>` tags; both must produce the
same `... [n] ...` shape + URL list so the eval represents production.
"""
import re

# `( https://... )` as rendered by the pipeline. The label is the surrounding text.
_LINK_RE = re.compile(r"\(\s*(https?://[^\s)]+)\s*\)")


def render_with_links(text: str) -> tuple[str, list[str]]:
    """Return (text with each link replaced by a [n] marker, [url_by_index])."""
    urls: list[str] = []

    def repl(match: re.Match) -> str:
        urls.append(match.group(1))
        return f"[{len(urls)}]"

    return _LINK_RE.sub(repl, text), urls


def resolve_link_indices(links, urls: list[str]) -> list[str]:
    """Map classified link indices back to their URLs, dropping out-of-range ones."""
    out: list[str] = []
    for link in links:
        i = link.index
        if 1 <= i <= len(urls):
            out.append(urls[i - 1])
    return out
