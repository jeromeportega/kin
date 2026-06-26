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

Each JSONL record carries `model`, `prompt_version`, and a `source` field (`classifier` | `db` | `error` | `filter` for dry-runs) so outputs stay interpretable as those evolve. Per-run stats land on stderr:

```
fetched=42 filtered=7 classified=7 reused=0 errors=0 truncated=0 elapsed=24.3s
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

## Phase 3 — Persistence (built)

Every triage run writes to a local SQLite database (default `data/kin.sqlite`, override via `KIN_DB_PATH`). The DB stores:

- **`emails`** — one row per unique message (`(user_id, message_id)`), including the body the model saw, so re-classification with a new prompt doesn't need IMAP.
- **`runs`** — one row per `app.triage` invocation, with counters and the args used.
- **`classifications`** — one row per `(email, model, prompt_version)` for successful classifications, plus error rows for retry history.

On a re-run, classifications matching the current `(model, prompt_version)` are loaded from the DB instead of re-classifying. JSONL records still emit for every survivor, but with `source: "db"` for cache hits. A prompt change (which bumps `prompt_version`) invalidates the cache automatically. Errors are stored but ignored by the cache lookup, so transient failures retry on the next run.

### New flags

| flag | default | meaning |
| ---- | ------- | ------- |
| `--no-db` | off | Skip all DB interaction (stateless behavior). |
| `--force-reclassify` | off | Ignore cached classifications; re-classify even on cache hits. |
| `--user NAME` | `$KIN_USER` or `jerome` | User scope, forward-compat for multi-user. |

### Peeking at the DB

```bash
# Recent runs
sqlite3 data/kin.sqlite \
  "SELECT id, started_at, fetched, filtered, classified, reused, errors FROM runs ORDER BY id DESC LIMIT 10;"

# Latest classifications joined with email metadata
sqlite3 data/kin.sqlite \
  "SELECT e.subject, c.category, c.priority, c.action_required FROM classifications c
     JOIN emails e ON e.id = c.email_id
    WHERE c.error IS NULL ORDER BY c.classified_at DESC LIMIT 10;"
```

WAL journal mode is enabled, so `sqlite3` can read while triage is mid-run.

### Exit codes

| code | meaning |
| ---- | ------- |
| 0 | success (including zero-survivor runs) |
| 1 | unexpected exception |
| 2 | config error (missing or malformed `kin.toml`/env) |
| 3 | IMAP connection/auth failure |
| 4 | model unreachable (every classification failed) |
| 5 | DB unreachable (open or schema mismatch) |

### Tests

```bash
uv run pytest tests/ -v
```

## Phase 4 — Daily digest (built)

`app.digest` reads `data/kin.sqlite` and produces a human-facing summary plus a structured JSON document. No IMAP, no LLM calls — purely a query over the persistence layer.

```bash
# Markdown to stdout, last 24 hours
uv run python -m app.digest

# Custom window
uv run python -m app.digest --hours 168          # weekly

# Save both formats
uv run python -m app.digest --out-md runs/today.md --out-json runs/today.json

# JSON to stdout (pipe to jq)
uv run python -m app.digest --out-json - | jq '.summary'

# Show 'other' (marketing/social) items in the groups
uv run python -m app.digest --include-other
```

Each invocation also writes a row to the `digests` table plus one row per included item to `digest_items` — useful for regression-testing future renderers against past output, and for answering "what was on the radar in late May?" months later. `--no-persist` opts out for ad-hoc runs.

The default query picks the **latest successful classification per email**, so a mid-day prompt iteration doesn't silently drop emails classified under the prior version. `--model` and `--prompt-version` (forensic flags) restrict to a specific pair when debugging.

### Filter and grouping rules

- `other` items are skipped from groups and surfaced as a single count line (unless `--include-other`).
- `high` and `medium` priority items are always rendered.
- `low` priority items are rendered only when `action_required=true` (matches the user-stated preference that low-priority FYIs hide behind a count).
- Within each priority section, items are grouped by `category` and sorted by email date (newest first).

### Peeking at persisted digests

```bash
sqlite3 data/kin.sqlite \
  "SELECT id, generated_at, classified_count, actionable_count, skipped_other_count
   FROM digests ORDER BY id DESC LIMIT 10;"

# Items in the latest digest, in their rendered order
sqlite3 data/kin.sqlite \
  "SELECT di.position, e.subject, c.category, c.priority
   FROM digest_items di
   JOIN classifications c ON c.id = di.classification_id
   JOIN emails e ON e.id = c.email_id
   WHERE di.digest_id = (SELECT max(id) FROM digests)
   ORDER BY di.position;"
```

### Schema migration

Phase 4 bumps `_meta.schema_version` from `1` to `2`. Existing Phase 3 DBs auto-migrate idempotently on first run of either `triage` or `digest` — the migration is purely additive (new `digests` and `digest_items` tables). `tests/fixtures/schema_v1.sql` snapshots the prior schema so future destructive migrations have something to test against.

## Phase 5 — Obsidian + Calendar sync (built)

`app.sync` exports the latest daily digest from `data/kin.sqlite` to two destinations:

- **Obsidian** — markdown files written into a configured vault. A date-stamped daily note (`<vault>/kin/digests/2026-05-20.md`) summarizes the day; each classified email gets its own note (`<vault>/kin/emails/<slug>.md`) with YAML frontmatter, action-item checkboxes, and dates. The daily note `[[wikilinks]]` to each per-email note for Obsidian's graph + Dataview.
- **Google Calendar / Apple Calendar** — an `.ics` file (default `runs/kin-<YYYY-MM-DD>.ics`) with one all-day `VEVENT` per actionable date. UIDs are UUID5-derived from `(message_id, date)`, so re-importing updates existing events instead of duplicating.

### Setup

```bash
# Point kin at your Obsidian vault root
echo 'KIN_OBSIDIAN_VAULT=/Users/you/Documents/Obsidian/Vault' >> .env

# (Optional) Override the ICS output path
# KIN_ICS_PATH=~/Library/Calendars/kin.ics
```

### Usage

```bash
# Sync the latest daily digest
uv run python -m app.sync

# Dry-run — show planned file writes without touching disk
uv run python -m app.sync --dry-run

# Sync a specific past digest by id
uv run python -m app.sync --digest-id 42

# Just write the calendar; skip the vault
uv run python -m app.sync --no-obsidian

# Pipe JSON-like ICS to stdout
uv run python -m app.sync --no-obsidian --ics-path -
```

| flag | default | meaning |
| ---- | ------- | ------- |
| `--user NAME` | `$KIN_USER` or `jerome` | User scope. |
| `--digest-id N` | latest | Sync a specific past digest. |
| `--vault-path PATH` | `$KIN_OBSIDIAN_VAULT` | Obsidian vault root. |
| `--ics-path PATH` | `runs/kin-<date>.ics` | Where to write the .ics. `-` means stdout. |
| `--no-obsidian` | off | Skip vault writes entirely. |
| `--no-ics` | off | Skip ICS export entirely. |
| `--dry-run` | off | Print planned paths; write nothing. |

### Implementation notes

- **Sync is idempotent.** Filenames and event UIDs are UUID5-derived from `message_id`, so re-running overwrites the same files and re-imported events update in place.
- **Read-only on the DB.** Sync opens `data/kin.sqlite` via SQLite's `mode=ro` URI form and verifies `_meta.schema_version` matches; never writes.
- **`window_hours = 24` default for "the latest digest"** — a forensic `app.digest --hours 720` doesn't accidentally become the synced daily note. Use `--digest-id N` to sync a forensic digest explicitly.
- **Local-time date for the daily-note filename**, UTC ISO for stored timestamps. An 11 PM Pacific run on May 19 writes `2026-05-19.md`, not `2026-05-20.md`.
- **Atomic writes** via same-directory `tempfile.NamedTemporaryFile` + `os.replace`. Partial writes never reach the vault.
- **Defense-in-depth path check**: every vault write is asserted to be under `<vault>/kin/` before it lands.

## Phase 6 — Email delivery (built)

`app.send` reads the latest daily digest from `data/kin.sqlite` and emails it as a `multipart/alternative` message (HTML + plain-text fallback). No IMAP, no LLM calls — purely read-only.

```bash
# Send the latest digest
uv run python -m app.send

# Preview the full RFC822 message; open no socket
uv run python -m app.send --dry-run

# Send a specific past digest by id
uv run python -m app.send --digest-id 42
```

| flag | default | meaning |
| ---- | ------- | ------- |
| `--user NAME` | `$KIN_USER` or `jerome` | User scope; rejects `--digest-id` records belonging to a different user. |
| `--digest-id N` | latest (24 h window) | Send a specific past digest instead of the most recent one. |
| `--dry-run` | off | Print the full RFC822 `multipart/alternative` to stdout; open no socket. |

### Recipient and transport resolution

| Env var | Default | Behavior |
| ------- | ------- | -------- |
| `KIN_DIGEST_TO` | — | Delivery address. Falls back to `GMAIL_ADDRESS` if unset. |
| `GMAIL_ADDRESS` | — | Required. Used as the sender and as the fallback recipient. Missing → `EXIT_CONFIG`. |
| `GMAIL_APP_PASSWORD` | — | Required. SMTP login password. Missing → `EXIT_CONFIG`. |
| `SMTP_HOST` | `smtp.gmail.com` | SMTP server host. |
| `SMTP_PORT` | `587` | SMTP server port (STARTTLS). |

Transport uses `smtplib.SMTP(host, port)` → `starttls()` → `login()` → `send_message()`. A rejected login raises `smtplib.SMTPException` and exits with code 1 (unexpected) — auth rejection is not mapped to `EXIT_CONFIG`.

### Exit codes

| code | meaning |
| ---- | ------- |
| 0 | message sent (or `--dry-run` printed) |
| 1 | unexpected exception (e.g. SMTP auth rejected, network error) |
| 2 | config error (missing `GMAIL_ADDRESS`, `GMAIL_APP_PASSWORD`, or no digest found) |
| 5 | DB unreachable or schema mismatch |

## Roadmap

1. Classify a single sample email ✅
2. Connect Gmail / IMAP with deterministic pre-filter ✅
3. Persist results to SQLite ✅
4. Daily digest ✅
5. Obsidian + Calendar export ✅
6. Email delivery ✅
7. Multi-user onboarding (`IMAPSource(folders=…)`, `user_id` columns, and `users/<name>/` TOML — see `docs/multi-user-customization.md`) ← *next*
