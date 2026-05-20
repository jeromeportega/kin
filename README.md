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

## Phase 1 — Email classifier (built)

Classify a single email and emit structured JSON:

```bash
uv run python -m app.classify_email data/samples/sample_email.txt
```

Output is validated against `app/schemas/email.py`:

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

Run the eval suite (six hand-labeled cases):

```bash
uv run python -m app.eval
```

## Phase 2 — Gmail triage (built)

`kin` pulls recent Gmail messages, drops the obvious noise with a deterministic pre-filter, runs the survivors through the Phase 1 classifier, and emits one JSON Lines record per processed email.

It is strictly **read-only on the mailbox** (`mark_seen=False`) and only reads `INBOX` — Gmail's spam filter is left to do its job.

### One-time setup

1. **Enable 2FA** on the Gmail account you want to triage.
2. **Generate an app password** at <https://myaccount.google.com/apppasswords> (pick "Mail", any device label).
3. Create your `.env`:
   ```bash
   cp .env.example .env
   chmod 600 .env
   ```
   Then fill in `GMAIL_ADDRESS` and `GMAIL_APP_PASSWORD`.
4. Create your filter config:
   ```bash
   cp kin.example.toml kin.toml
   ```
   Edit `kin.toml` — add your real daycare/pediatrician/school senders to `sender_allowlist` and tweak `subject_keywords` for your household. `kin.toml` is gitignored.

### Usage

Dry run — apply the pre-filter, print survivors, do not call the model:

```bash
uv run python -m app.triage --dry-run
```

Full triage — classify the survivors:

```bash
uv run python -m app.triage --out triage.jsonl
```

Useful flags:

| flag | default | meaning |
| ---- | ------- | ------- |
| `--hours N` | 24 | Look back this many hours. |
| `--limit N` | 200 | Hard cap on classified messages per run. |
| `--out PATH` | — | Also write JSONL to this path. |
| `--dry-run` | off | Skip the LLM; just print filter survivors. |
| `--model NAME` | `qwen3:14b` | Ollama model tag. |
| `--config PATH` | `kin.toml` | Filter config path. |

Each JSONL record carries `model` and `prompt_version` so outputs stay interpretable as those evolve. Per-run stats land on stderr:

```
fetched=42 filtered=7 classified=7 errors=0 truncated=0 elapsed=24.3s
```

### Bootstrapping `kin.toml` — the `audit` helper

Picking the right allowlist/blocklist entries is easier with real data in front of you. The `app.audit` helper scans a single IMAP folder and prints per-sender message counts plus sample subjects — perfect for spotting who deserves an allowlist entry (recurring senders in INBOX) and who deserves a blocklist entry (senders that pile up in Trash).

```bash
# Top senders in your INBOX over the last 7 days
uv run python -m app.audit

# What ends up in Trash (for blocklist candidates)
uv run python -m app.audit --folder "[Gmail]/Trash"

# Longer window, only senders with >=3 messages
uv run python -m app.audit --days 30 --min-count 3
```

The audit tool reads only — same `mark_seen=False` guarantee as triage.

### Exit codes

| code | meaning |
| ---- | ------- |
| 0 | success (including zero-survivor runs) |
| 1 | unexpected exception |
| 2 | config error (missing or malformed `kin.toml`/env) |
| 3 | IMAP connection/auth failure |
| 4 | model unreachable (every classification failed) |

### Tests

```bash
uv run pytest tests/ -v
```

## Roadmap

1. Classify a single sample email ✅
2. Connect Gmail / IMAP with deterministic pre-filter ✅
3. Persist results to SQLite ← *next*
4. Daily digest
5. Notion + Google Calendar integration
6. Multi-folder / multi-user (`IMAPSource(folders=…)` seam is already in place)
