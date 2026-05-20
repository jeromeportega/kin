"""Run all eval cases and report per-field accuracy.

Usage:
    python -m app.eval
    python -m app.eval --model qwen3:8b
"""
import argparse
import json
import sys
from pathlib import Path

from app.classify_email import MODEL, classify
from app.schemas.email import EmailClassification

CASES_DIR = Path(__file__).parent.parent / "data" / "eval" / "cases"
SCORED_FIELDS = ("category", "priority", "action_required", "dates")


def load_cases() -> list[tuple[str, str, dict]]:
    cases = []
    for txt in sorted(CASES_DIR.glob("*.txt")):
        expected = json.loads(txt.with_suffix(".expected.json").read_text())
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=MODEL)
    args = parser.parse_args()

    cases = load_cases()
    if not cases:
        print(f"No cases found in {CASES_DIR}", file=sys.stderr)
        return 1

    totals = {f: [0, 0] for f in SCORED_FIELDS}  # [passes, total]
    per_case_lines = []

    for case_id, email_text, expected in cases:
        actual = classify(email_text, model=args.model)
        case_results = score(expected, actual)
        marks = []
        for field, passed in case_results.items():
            totals[field][1] += 1
            totals[field][0] += int(passed)
            marks.append(f"{field}={'PASS' if passed else f'FAIL(got {getattr(actual, field)!r}, want {expected[field]!r})'}")
        per_case_lines.append(f"  {case_id}: {' | '.join(marks)}")

    print(f"Model: {args.model}")
    print(f"Cases: {len(cases)}\n")
    print("Per-case results:")
    print("\n".join(per_case_lines))
    print("\nField accuracy:")
    for field, (passes, total) in totals.items():
        if total == 0:
            continue
        pct = 100.0 * passes / total
        print(f"  {field}: {passes}/{total} ({pct:.0f}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
