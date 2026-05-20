# kin

Local-first AI for personal and family workflows. Runs entirely on your machine via [Ollama](https://ollama.com/) — no recurring API costs, no family data leaving the house.

## Setup

```bash
# One-time
brew install ollama uv
brew services start ollama
ollama pull qwen3:14b

# Project deps
uv sync
```

## Phase 1 — Email classifier

```bash
# Classify a single email
uv run python -m app.classify_email data/samples/sample_email.txt

# Run the eval suite
uv run python -m app.eval
```

Output is JSON validated against `app/schemas/email.py`:

```json
{
  "category": "daycare",
  "priority": "high",
  "action_required": true,
  "summary": "...",
  "action_items": ["..."],
  "dates": ["2026-05-28", "2026-05-30"],
  "confidence": 0.92
}
```

## Roadmap

1. Classify a single sample email ← *we are here*
2. Connect Gmail / IMAP with deterministic pre-filter
3. Persist results to SQLite
4. Daily digest
5. Notion + Google Calendar integration
