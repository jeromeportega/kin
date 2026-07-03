"""Run all eval cases and report per-field accuracy.

Cases live under `data/eval/<set>/`. Each `<case>.txt` has a sibling
`<case>.expected.json` containing the subset of fields to score against.

Two sets are bundled:
- `cases`  — synthetic emails hand-written for Phase 1 / quick smoke-testing
- `real`   — anonymized real-mail samples for measuring distribution-shift

Usage:
    uv run python -m app.eval                    # both sets, combined report
    uv run python -m app.eval --set cases        # synthetic only
    uv run python -m app.eval --set real         # real-mail only
    uv run python -m app.eval --model qwen3:8b   # try a smaller model
"""
import argparse
import json
import sys
from pathlib import Path

from app.classify_email import MODEL, classify
from app.links import render_with_links, resolve_link_indices
from app.schemas.email import EmailClassification

EVAL_BASE = Path(__file__).parent.parent / "data" / "eval"
SCORED_FIELDS = ("category", "priority", "action_required", "dates", "links", "events")
DEFAULT_SETS = ("cases", "real")


def _norm_url(u: str) -> str:
    return u.strip().rstrip("/")


def _date_part(s: str) -> str:
    return s[:10]  # YYYY-MM-DD portion of an ISO date/datetime


def load_set(set_name: str) -> list[tuple[str, str, dict]]:
    """Return [(case_id, email_text, expected), ...] for a set."""
    cases = []
    d = EVAL_BASE / set_name
    if not d.exists():
        return cases
    for txt in sorted(d.glob("*.txt")):
        expected_path = txt.with_suffix(".expected.json")
        if not expected_path.exists():
            continue
        expected = json.loads(expected_path.read_text())
        cases.append((txt.stem, txt.read_text(), expected))
    return cases


def score(expected: dict, actual: EmailClassification, urls: list[str]) -> dict[str, bool]:
    actual_dump = actual.model_dump(mode="json")
    results = {}
    for field in SCORED_FIELDS:
        if field not in expected:
            continue
        if field == "dates":
            results[field] = set(expected[field]) == set(actual_dump[field])
        elif field == "links":
            # Resolve the model's chosen marker indices to their real URLs, then
            # compare as a set — enforces recall (found the CTA) AND selectivity
            # (didn't drag in footer/nav/social links). Labels aren't scored.
            got = {_norm_url(u) for u in resolve_link_indices(actual.links, urls)}
            want = {_norm_url(u) for u in expected["links"]}
            results[field] = got == want
        elif field == "events":
            # Compare the event start DATES (robust to time-format wobble) and
            # require each event to have a non-empty title. expected["events"] is
            # a list of expected start-date strings.
            got = {_date_part(e["start"]) for e in actual_dump["events"]}
            want = {_date_part(d) for d in expected["events"]}
            titles_ok = all(e.get("title") for e in actual_dump["events"])
            results[field] = got == want and titles_ok
        else:
            results[field] = expected[field] == actual_dump[field]
    return results


def report_set(
    set_name: str,
    results: list[tuple[str, EmailClassification, list[str], dict, dict[str, bool]]],
) -> dict[str, list[int]]:
    print(f"\n=== set: {set_name} ({len(results)} cases) ===")
    totals: dict[str, list[int]] = {f: [0, 0] for f in SCORED_FIELDS}
    for case_id, actual, urls, expected, case_results in results:
        marks = []
        for field, passed in case_results.items():
            totals[field][1] += 1
            totals[field][0] += int(passed)
            if passed:
                marks.append(f"{field}=PASS")
            else:
                got = (
                    resolve_link_indices(actual.links, urls)
                    if field == "links"
                    else getattr(actual, field)
                )
                want = expected[field]
                marks.append(f"{field}=FAIL(got {got!r}, want {want!r})")
        print(f"  {case_id}: {' | '.join(marks)}")
    print(f"\n  field accuracy ({set_name}):")
    for field, (passes, total) in totals.items():
        if total == 0:
            continue
        pct = 100.0 * passes / total
        print(f"    {field}: {passes}/{total} ({pct:.0f}%)")
    return totals


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=MODEL)
    parser.add_argument(
        "--set",
        action="append",
        choices=DEFAULT_SETS,
        help="Eval set(s) to run; default: both.",
    )
    args = parser.parse_args()

    sets = args.set if args.set else list(DEFAULT_SETS)
    print(f"Model: {args.model}")

    grand_totals: dict[str, list[int]] = {f: [0, 0] for f in SCORED_FIELDS}
    any_run = False

    for set_name in sets:
        cases = load_set(set_name)
        if not cases:
            print(f"\n=== set: {set_name} (no cases found) ===")
            continue
        results = []
        for case_id, email_text, expected in cases:
            annotated, urls = render_with_links(email_text)
            actual = classify(annotated, model=args.model)
            results.append((case_id, actual, urls, expected, score(expected, actual, urls)))
        totals = report_set(set_name, results)
        any_run = True
        for f, (p, t) in totals.items():
            grand_totals[f][0] += p
            grand_totals[f][1] += t

    if any_run and len(sets) > 1:
        print("\n=== combined ===")
        for field, (passes, total) in grand_totals.items():
            if total == 0:
                continue
            pct = 100.0 * passes / total
            print(f"  {field}: {passes}/{total} ({pct:.0f}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
