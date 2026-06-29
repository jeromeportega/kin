import "server-only"
import { dbClient } from "./db"

// The household filter config lives in the DB (filter_entries) — read by the
// dashboard/tuning UI and the ingest pipeline, so they never desync. The DB is
// Turso in production and the local SQLite file in dev (via dbClient).

export interface KinConfig {
  sender_allowlist: string[]
  sender_blocklist: string[]
  subject_keywords: string[]
}

const KINDS = ["sender_allowlist", "sender_blocklist", "subject_keywords"] as const

export async function readKinConfig(userId: string): Promise<KinConfig> {
  const rs = await dbClient().execute({
    sql: "SELECT kind, value FROM filter_entries WHERE user_id = ? ORDER BY kind, value",
    args: [userId],
  })
  const out: KinConfig = { sender_allowlist: [], sender_blocklist: [], subject_keywords: [] }
  for (const row of rs.rows) {
    const kind = String(row.kind)
    if (kind === "sender_allowlist" || kind === "sender_blocklist" || kind === "subject_keywords") {
      out[kind].push(String(row.value))
    }
  }
  return out
}

export interface TuningPatch {
  allow?: string[]
  block?: string[]
  keyword?: string[]
}

// Reject anything that can't be a safe value (quotes/newlines/backslashes).
function sanitize(values: string[]): string[] {
  return values.map((v) => v.trim()).filter((v) => v.length > 0 && !/["\n\r\\]/.test(v))
}

/**
 * Apply tuning answers — idempotent inserts. Values are lowercased to match the
 * pipeline's normalization. Returns the number of NEW entries added per list.
 */
export async function applyTuning(
  patch: TuningPatch,
  userId: string
): Promise<Record<string, number>> {
  const additions: Record<(typeof KINDS)[number], string[]> = {
    sender_allowlist: sanitize(patch.allow ?? []),
    sender_blocklist: sanitize(patch.block ?? []),
    subject_keywords: sanitize(patch.keyword ?? []),
  }

  const added: Record<string, number> = {}
  for (const kind of KINDS) {
    let n = 0
    for (const value of additions[kind]) {
      const rs = await dbClient().execute({
        sql: "INSERT OR IGNORE INTO filter_entries (user_id, kind, value) VALUES (?, ?, ?)",
        args: [userId, kind, value.toLowerCase()],
      })
      if (Number(rs.rowsAffected) > 0) n += 1
    }
    added[kind] = n
  }
  return added
}

// Mute / unmute a sender — the in-flow blocklist. Muted senders are skipped by
// the pipeline (shouldClassify) before classification, so they cost nothing and
// drop out of the dashboard.
export async function muteSender(userId: string, sender: string): Promise<void> {
  const value = sender.trim().toLowerCase()
  if (!value) return
  await dbClient().execute({
    sql: "INSERT OR IGNORE INTO filter_entries (user_id, kind, value) VALUES (?, 'sender_blocklist', ?)",
    args: [userId, value],
  })
}

export async function unmuteSender(userId: string, sender: string): Promise<void> {
  await dbClient().execute({
    sql: "DELETE FROM filter_entries WHERE user_id = ? AND kind = 'sender_blocklist' AND value = ?",
    args: [userId, sender.trim().toLowerCase()],
  })
}
