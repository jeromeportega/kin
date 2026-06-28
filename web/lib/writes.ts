import "server-only"
import { dbClient } from "./db"
import type { FetchedEmail } from "./filter"
import type { EmailClassification } from "./classify"

// TS port of the write half of app/db.py (the reads are in lib/api.ts). All run
// against the same libSQL DB via dbClient — Turso in prod, the local SQLite file
// in dev. Timestamps are passed in as ISO strings (…+00:00) to match the format
// the Python pipeline stored and the reads compare against.

export async function upsertEmail(opts: {
  userId: string
  folder: string
  msg: FetchedEmail
  now: string
}): Promise<number> {
  const { userId, folder, msg, now } = opts
  const rs = await dbClient().execute({
    sql: `INSERT INTO emails (
            user_id, folder, message_id, uid, from_addr, subject,
            date, text_body, truncated, first_seen_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (user_id, message_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
          RETURNING id`,
    args: [
      userId,
      folder,
      msg.message_id,
      msg.uid,
      msg.from_addr,
      msg.subject,
      msg.date,
      msg.text_body,
      msg.truncated ? 1 : 0,
      now,
      now,
    ],
  })
  return Number(rs.rows[0].id)
}

/** Most recent successful classification for (email, model, prompt) — the dedup cache. */
export async function findClassification(opts: {
  emailId: number
  model: string
  promptVersion: string
}): Promise<EmailClassification | null> {
  const rs = await dbClient().execute({
    sql: `SELECT category, priority, action_required, summary, action_items, dates, confidence
          FROM classifications
          WHERE email_id = ? AND model = ? AND prompt_version = ? AND error IS NULL
          ORDER BY classified_at DESC LIMIT 1`,
    args: [opts.emailId, opts.model, opts.promptVersion],
  })
  const row = rs.rows[0]
  if (!row) return null
  return {
    category: String(row.category),
    priority: String(row.priority),
    action_required: Boolean(row.action_required),
    summary: String(row.summary),
    action_items: JSON.parse(String(row.action_items)),
    dates: JSON.parse(String(row.dates)),
    confidence: Number(row.confidence),
  } as EmailClassification
}

export async function insertClassification(opts: {
  emailId: number
  runId: number | null
  model: string
  promptVersion: string
  result: EmailClassification
  truncated: boolean
  now: string
}): Promise<number> {
  const { emailId, runId, model, promptVersion, result, truncated, now } = opts
  const rs = await dbClient().execute({
    sql: `INSERT INTO classifications (
            email_id, run_id, model, prompt_version,
            category, priority, action_required, summary,
            action_items, dates, confidence, truncated, error, classified_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    args: [
      emailId,
      runId,
      model,
      promptVersion,
      result.category,
      result.priority,
      result.action_required ? 1 : 0,
      result.summary,
      JSON.stringify(result.action_items),
      JSON.stringify(result.dates),
      result.confidence,
      truncated ? 1 : 0,
      now,
    ],
  })
  return Number(rs.lastInsertRowid)
}

export async function insertClassificationError(opts: {
  emailId: number
  runId: number | null
  model: string
  promptVersion: string
  error: string
  truncated: boolean
  now: string
}): Promise<number> {
  const { emailId, runId, model, promptVersion, error, truncated, now } = opts
  const rs = await dbClient().execute({
    sql: `INSERT INTO classifications (
            email_id, run_id, model, prompt_version,
            category, priority, action_required, summary,
            action_items, dates, confidence, truncated, error, classified_at
          ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    args: [emailId, runId, model, promptVersion, truncated ? 1 : 0, error, now],
  })
  return Number(rs.lastInsertRowid)
}

export async function startRun(opts: {
  userId: string
  args: Record<string, unknown>
  model: string
  promptVersion: string
  hours: number
  limitN: number
  now: string
}): Promise<number> {
  const rs = await dbClient().execute({
    sql: `INSERT INTO runs (user_id, started_at, hours, limit_n, model, prompt_version, args)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      opts.userId,
      opts.now,
      opts.hours,
      opts.limitN,
      opts.model,
      opts.promptVersion,
      JSON.stringify(opts.args),
    ],
  })
  return Number(rs.lastInsertRowid)
}

export async function finishRun(opts: {
  runId: number
  fetched: number
  filtered: number
  classified: number
  reused: number
  errors: number
  truncated: number
  now: string
}): Promise<void> {
  await dbClient().execute({
    sql: `UPDATE runs SET ended_at = ?, fetched = ?, filtered = ?, classified = ?,
            reused = ?, errors = ?, truncated = ? WHERE id = ?`,
    args: [
      opts.now,
      opts.fetched,
      opts.filtered,
      opts.classified,
      opts.reused,
      opts.errors,
      opts.truncated,
      opts.runId,
    ],
  })
}
