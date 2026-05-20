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
from app.schemas.email import EmailClassification

EVAL_BASE = Path(__file__).parent.parent / "data" / "eval"
SCORED_FIELDS = ("category", "priority", "action_required", "dates")
DEFAULT_SETS = ("cases", "real")


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


def score(expected: dict, actual: EmailClassification) -> dict[str, bool]:
    actual_dump = actual.model_dump(mode="json")
    results = {}
    for field in SCORED_FIELDS:
        if field not in expected:
            continue
        if field == "dates":
            results[field] = set(expected[field]) == set(actual_dump[field])
        else:
            results[field] = expected[field] == actual_dump[field]
    return results


def report_set(
    set_name: str,
    results: list[tuple[str, EmailClassification, dict, dict[str, bool]]],
) -> dict[str, list[int]]:
    print(f"\n=== set: {set_name} ({len(results)} cases) ===")
    totals: dict[str, list[int]] = {f: [0, 0] for f in SCORED_FIELDS}
    for case_id, actual, expected, case_results in results:
        marks = []
        for field, passed in case_results.items():
            totals[field][1] += 1
            totals[field][0] += int(passed)
            if passed:
                marks.append(f"{field}=PASS")
            else:
                got = getattr(actual, field)
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
            actual = classify(email_text, model=args.model)
            results.append((case_id, actual, expected, score(expected, actual)))
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
