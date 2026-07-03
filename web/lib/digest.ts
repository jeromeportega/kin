import "server-only"
import type { Classification, Digest, DigestItem } from "./types"
import { fetchClassifications } from "./api"
import { dbClient } from "./db"
import { MODEL, PROMPT_VERSION } from "./classify"

// TS port of app/digest.py build_digest + render + db.insert_digest. The dashboard
// reads the persisted json_payload; the markdown column is kept for parity.

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 }
const isoUtc = (d: Date) => d.toISOString().replace("Z", "+00:00")
const isoToEpoch = (s: string) => {
  const t = Date.parse(s)
  return Number.isNaN(t) ? 0 : t
}

/**
 * Routing: `other` increments the gross count (included only if includeOther);
 * high/medium always shown; low only if actionable; else dropped. Sorted by
 * priority, then actionable-first, then category, then date desc.
 */
export function buildDigest(
  rows: Classification[],
  opts: { userId: string; hours: number; now: Date; includeOther: boolean }
): Digest {
  const { userId, hours, now, includeOther } = opts
  const windowStart = new Date(now.getTime() - hours * 3_600_000)

  let actionable = 0
  let informational = 0
  let skippedOther = 0
  let droppedLow = 0
  const items: DigestItem[] = []

  for (const r of rows) {
    if (r.category === "other") {
      skippedOther += 1
      if (!includeOther) continue
    }

    let shown: boolean
    if (r.priority === "high" || r.priority === "medium") shown = true
    else if (r.priority === "low" && r.action_required) shown = true
    else {
      droppedLow += 1
      shown = false
    }
    if (!shown) continue

    if (r.action_required) actionable += 1
    else informational += 1

    items.push({
      classification_id: r.classification_id,
      message_id: r.message_id,
      uid: r.uid,
      from_addr: r.from_addr,
      subject: r.subject,
      date: r.email_date,
      category: r.category,
      priority: r.priority,
      action_required: r.action_required,
      summary: r.summary,
      action_items: r.action_items,
      dates: r.dates,
      links: r.links,
      confidence: r.confidence,
      model: r.model,
      prompt_version: r.prompt_version,
      classified_at: r.classified_at,
    })
  }

  items.sort(
    (a, b) =>
      (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99) ||
      (a.action_required ? 0 : 1) - (b.action_required ? 0 : 1) ||
      a.category.localeCompare(b.category) ||
      isoToEpoch(b.date) - isoToEpoch(a.date)
  )

  return {
    generated_at: isoUtc(now),
    user_id: userId,
    model: null,
    prompt_version: null,
    window_hours: hours,
    window_start: isoUtc(windowStart),
    window_end: isoUtc(now),
    include_other: includeOther,
    classified_count: rows.length,
    actionable_count: actionable,
    informational_count: informational,
    skipped_other_count: skippedOther,
    dropped_low_count: droppedLow,
    items,
  }
}

const mdEscape = (s: string) => s.replace(/`/g, "\\`").replace(/\|/g, "\\|")

export function renderMarkdown(digest: Digest): string {
  const lines: string[] = [`# kin daily digest — ${digest.generated_at}`, ""]
  const bits = [
    `Window: last ${digest.window_hours} hours`,
    `${digest.classified_count} classified`,
    `${digest.actionable_count} actionable`,
    `${digest.informational_count} informational`,
  ]
  if (digest.skipped_other_count && !digest.include_other) {
    bits.push(`${digest.skipped_other_count} skipped as \`other\``)
  }
  if (digest.dropped_low_count) bits.push(`${digest.dropped_low_count} low-priority FYIs hidden`)
  lines.push(bits.join(" · "), "")

  const sections: [string, string][] = [
    ["🚨 High priority", "high"],
    ["⚠️ Medium priority", "medium"],
    ["ℹ️ Low priority — actionable", "low"],
  ]
  for (const [heading, pri] of sections) {
    const group = digest.items.filter((i) => i.priority === pri)
    if (!group.length) continue
    lines.push(`## ${heading} (${group.length})`, "")
    const cats = [...new Set(group.map((i) => i.category))].sort()
    for (const cat of cats) {
      const catItems = group.filter((i) => i.category === cat)
      lines.push(`### ${cat} (${catItems.length})`, "")
      for (const item of catItems) {
        lines.push(`- **${mdEscape(item.subject) || "(no subject)"}**`)
        lines.push(`  - From: ${mdEscape(item.from_addr)} · ${item.date}`)
        if (item.dates.length) lines.push(`  - Dates: ${item.dates.join(", ")}`)
        if (item.summary) lines.push(`  - _${mdEscape(item.summary)}_`)
        if (item.action_items.length) {
          lines.push("  - Actions:")
          for (const a of item.action_items) lines.push(`    - ${mdEscape(a)}`)
        }
        lines.push("")
      }
    }
  }
  return lines.join("\n").trimEnd() + "\n"
}

/** Persist a digest + its items (port of db.insert_digest). Returns the digest id. */
export async function insertDigest(
  digest: Digest,
  opts: { markdown: string; jsonPayload: string; classificationIds: number[] }
): Promise<number> {
  const expected = digest.actionable_count + digest.informational_count
  if (opts.classificationIds.length !== expected) {
    throw new Error(`digest counter mismatch: ${opts.classificationIds.length} item ids vs ${expected}`)
  }

  const rs = await dbClient().execute({
    sql: `INSERT INTO digests (
            user_id, generated_at, window_hours, window_start, window_end,
            model, prompt_version, include_other, args,
            classified_count, actionable_count, informational_count,
            skipped_other_count, dropped_low_count, markdown, json_payload
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING id`,
    args: [
      digest.user_id,
      digest.generated_at,
      digest.window_hours,
      digest.window_start,
      digest.window_end,
      digest.model ?? MODEL,
      digest.prompt_version ?? PROMPT_VERSION,
      digest.include_other ? 1 : 0,
      JSON.stringify({ user_id: digest.user_id, hours: digest.window_hours }),
      digest.classified_count,
      digest.actionable_count,
      digest.informational_count,
      digest.skipped_other_count,
      digest.dropped_low_count,
      opts.markdown,
      opts.jsonPayload,
    ],
  })
  const digestId = Number(rs.rows[0].id)

  for (let i = 0; i < opts.classificationIds.length; i++) {
    await dbClient().execute({
      sql: "INSERT INTO digest_items (digest_id, classification_id, position) VALUES (?, ?, ?)",
      args: [digestId, opts.classificationIds[i], i],
    })
  }
  return digestId
}

/** Build + persist the daily (24h) digest for a user. */
export async function runDigest(userId: string, hours = 24): Promise<Digest> {
  const rows = await fetchClassifications(userId, hours)
  const digest = buildDigest(rows, { userId, hours, now: new Date(), includeOther: false })
  const markdown = renderMarkdown(digest)
  const jsonPayload = JSON.stringify(digest, null, 2)
  await insertDigest(digest, {
    markdown,
    jsonPayload,
    classificationIds: digest.items.map((i) => i.classification_id),
  })
  return digest
}
