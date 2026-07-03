import "server-only"
import type { Digest, Classification } from "@/lib/types"
import { dbClient } from "./db"
import { LOOKBACK_HOURS } from "./constants"

// Reads query the DB directly via libSQL (Turso in prod, the local SQLite file in
// dev) — no separate API service. These mirror app/db.fetch_latest_digest_json and
// fetch_classifications_window.

// Must match the window the digest is built with (ingest → runDigest).
const DIGEST_WINDOW_HOURS = LOOKBACK_HOURS

// Match Python's datetime.isoformat() (…+00:00) so string comparison against the
// stored email dates behaves identically.
function isoBound(d: Date): string {
  return d.toISOString().replace("Z", "+00:00")
}

export async function fetchDigest(userId: string): Promise<Digest | null> {
  if (!userId) throw new Error("userId is required")
  const rs = await dbClient().execute({
    sql: `SELECT json_payload FROM digests
          WHERE user_id = ? AND window_hours = ?
          ORDER BY id DESC LIMIT 1`,
    args: [userId, DIGEST_WINDOW_HOURS],
  })
  const row = rs.rows[0]
  if (!row) return null
  const data = JSON.parse(String(row.json_payload)) as Digest
  if (data.items.length === 0) return null
  return data
}

export async function fetchClassifications(
  userId: string,
  hours: number
): Promise<Classification[]> {
  if (!userId) throw new Error("userId is required")
  if (!Number.isInteger(hours) || hours <= 0) {
    throw new Error("hours must be a positive integer")
  }
  const end = new Date()
  const start = new Date(end.getTime() - hours * 3_600_000)

  // Latest successful classification per email in the window (mirrors the API).
  const rs = await dbClient().execute({
    sql: `
      SELECT
        c.id AS classification_id, c.model, c.prompt_version, c.category,
        c.priority, c.action_required, c.summary, c.action_items, c.dates,
        c.links, c.events, c.confidence, c.classified_at,
        e.id AS email_id, e.message_id, e.uid, e.folder, e.from_addr,
        e.subject, e.date AS email_date
      FROM classifications c
      JOIN emails e ON e.id = c.email_id
      WHERE c.error IS NULL
        AND e.user_id = ?
        AND e.date >= ?
        AND e.date <= ?
        AND c.id = (
          SELECT c2.id FROM classifications c2
          WHERE c2.email_id = e.id AND c2.error IS NULL
          ORDER BY c2.classified_at DESC, c2.id DESC LIMIT 1
        )
      ORDER BY e.date DESC`,
    args: [userId, isoBound(start), isoBound(end)],
  })

  return rs.rows.map((r) => ({
    classification_id: Number(r.classification_id),
    model: String(r.model),
    prompt_version: String(r.prompt_version),
    category: String(r.category),
    priority: String(r.priority),
    action_required: Boolean(r.action_required),
    summary: String(r.summary),
    action_items: JSON.parse(String(r.action_items)),
    dates: JSON.parse(String(r.dates)),
    links: r.links == null ? [] : JSON.parse(String(r.links)),
    events: r.events == null ? [] : JSON.parse(String(r.events)),
    confidence: Number(r.confidence),
    classified_at: String(r.classified_at),
    email_id: Number(r.email_id),
    message_id: String(r.message_id),
    uid: r.uid == null ? null : String(r.uid),
    folder: String(r.folder),
    from_addr: String(r.from_addr),
    subject: String(r.subject),
    email_date: String(r.email_date),
  })) as Classification[]
}
