import argparse
import hashlib
import sys
from pathlib import Path

import ollama

from app.schemas.email import EmailClassification


MODEL = "qwen3:14b"
PROMPT_PATH = Path(__file__).parent / "prompts" / "classify.txt"
PROMPT_VERSION = hashlib.sha256(PROMPT_PATH.read_bytes()).hexdigest()[:12]


def classify(email_text: str, model: str = MODEL) -> EmailClassification:
    prompt = PROMPT_PATH.read_text().replace("{{EMAIL}}", email_text)

    response = ollama.chat(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        format=EmailClassification.model_json_schema(),
        options={"temperature": 0.0},
    )

    return EmailClassification.model_validate_json(response["message"]["content"])


def main() -> int:
    parser = argparse.ArgumentParser(description="Classify an email with a local Ollama model.")
    parser.add_argument("path", nargs="?", help="Path to an email file; reads stdin if omitted.")
    parser.add_argument("--model", default=MODEL, help=f"Ollama model tag (default: {MODEL}).")
    args = parser.parse_args()

    email_text = Path(args.path).read_text() if args.path else sys.stdin.read()
    result = classify(email_text, model=args.model)
    print(result.model_dump_json(indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
