import argparse
import hashlib
import sys
from pathlib import Path

import anthropic

from app.schemas.email import EmailClassification


# Sonnet is the right tier for high-volume, rubric-driven email classification:
# strong instruction-following at ~half Opus's per-token cost. Validate accuracy
# with `app.eval` before dropping to Haiku (cheaper) or bumping to Opus (pricier).
MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 1024
PROMPT_PATH = Path(__file__).parent / "prompts" / "classify.txt"
PROMPT_VERSION = hashlib.sha256(PROMPT_PATH.read_bytes()).hexdigest()[:12]

# Lazily constructed so importing this module never requires ANTHROPIC_API_KEY
# (tests stub `classify`; the key is only needed for a real classification call).
_client: anthropic.Anthropic | None = None


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the environment
    return _client


def classify(email_text: str, model: str = MODEL) -> EmailClassification:
    # Split the prompt at the {{EMAIL}} marker so the large, stable instruction
    # block is sent as a cached `system` prefix and only the volatile email
    # varies per request. `cache_control` enables prompt caching (cached prefix
    # reads cost ~0.1x). NOTE: caching only engages once that prefix clears the
    # model's minimum (2048 tokens on Sonnet 4.6, 4096 on Opus); the current
    # instructions are ~1.3k tokens, so it no-ops until the prompt grows.
    instructions, closing = PROMPT_PATH.read_text().split("{{EMAIL}}", 1)

    # No sampling params (temperature/top_p are rejected on 4.x). The schema is
    # enforced by output_format; `.parsed_output` is a validated instance.
    response = _get_client().messages.parse(
        model=model,
        max_tokens=MAX_TOKENS,
        system=[
            {
                "type": "text",
                "text": instructions,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": email_text + closing}],
        output_format=EmailClassification,
    )

    result = response.parsed_output
    if result is None:
        raise RuntimeError(
            f"classification returned no parsed output "
            f"(stop_reason={response.stop_reason})"
        )
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Classify an email with the Anthropic API.")
    parser.add_argument("path", nargs="?", help="Path to an email file; reads stdin if omitted.")
    parser.add_argument("--model", default=MODEL, help=f"Anthropic model id (default: {MODEL}).")
    args = parser.parse_args()

    email_text = Path(args.path).read_text() if args.path else sys.stdin.read()
    result = classify(email_text, model=args.model)
    print(result.model_dump_json(indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
