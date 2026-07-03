import "server-only"
import { dbClient } from "./db"
import { readRefreshToken } from "./tokenStore"
import { mintAccessToken, fetchRecent, ReauthRequired } from "./gmail"
import { shouldClassify, type FetchedEmail, type FilterConfig } from "./filter"
import type { ResolvedLink } from "./types"
import { classify, MODEL, PROMPT_VERSION } from "./classify"
import { upsertEmail, findClassification, insertClassification } from "./writes"
import { runDigest } from "./digest"
import { LOOKBACK_HOURS } from "./constants"

// TS port of ingest/run.py — fetch recent Gmail, filter, classify, persist. The
// digest build is increment 5. (ingest/run.py does not touch the `runs` table.)

const KINDS = ["sender_allowlist", "sender_blocklist", "subject_keywords", "body_keywords"] as const

async function readFilterConfig(userId: string): Promise<FilterConfig> {
  const rs = await dbClient().execute({
    sql: "SELECT kind, value FROM filter_entries WHERE user_id = ?",
    args: [userId],
  })
  const cfg: FilterConfig = {
    sender_allowlist: [],
    sender_blocklist: [],
    subject_keywords: [],
    body_keywords: [],
  }
  for (const row of rs.rows) {
    const kind = String(row.kind)
    if ((KINDS as readonly string[]).includes(kind)) {
      cfg[kind as (typeof KINDS)[number]].push(String(row.value))
    }
  }
  return cfg
}

const nowIso = () => new Date().toISOString().replace("Z", "+00:00")

// The plain-text shape the classifier expects (mirrors ingest/run._render_for_model).
function renderForModel(msg: FetchedEmail): string {
  return [`From: ${msg.from_addr}`, `Subject: ${msg.subject}`, `Date: ${msg.date}`, "", msg.text_body].join(
    "\n"
  )
}

function googleCreds(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? process.env.AUTH_GOOGLE_ID ?? ""
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? process.env.AUTH_GOOGLE_SECRET ?? ""
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set")
  }
  return { clientId, clientSecret }
}

// How many emails to classify at once. A backfill re-classifies the whole inbox,
// so sequential classification could exceed the function time limit.
const CLASSIFY_CONCURRENCY = 6

interface Outcome {
  filtered: number
  classified: number
  reused: number
  errors: number
}
const NO_OUTCOME: Outcome = { filtered: 0, classified: 0, reused: 0, errors: 0 }

/** Map over items with bounded concurrency, preserving input order in results. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

export interface IngestResult {
  fetched: number
  filtered: number
  classified: number
  reused: number
  errors: number
}

export async function runIngest(
  userId: string,
  opts: { hours?: number; limit?: number } = {}
): Promise<IngestResult> {
  const hours = opts.hours ?? LOOKBACK_HOURS
  const limit = opts.limit ?? 50

  const cfg = await readFilterConfig(userId)

  const refreshToken = await readRefreshToken(userId)
  if (!refreshToken) throw new ReauthRequired(`no refresh token for ${userId}`)
  const { clientId, clientSecret } = googleCreds()
  const accessToken = await mintAccessToken(refreshToken, clientId, clientSecret)

  const emails = await fetchRecent({ accessToken, hours, limit })

  // One email's full flow — filter, upsert, dedup, classify, persist. Returns the
  // counter deltas so the emails can be processed concurrently and aggregated.
  async function processOne(msg: FetchedEmail): Promise<Outcome> {
    if (!shouldClassify(msg, cfg)) return { ...NO_OUTCOME }

    let emailId: number
    try {
      emailId = await upsertEmail({ userId, folder: "INBOX", msg, now: nowIso() })
    } catch {
      return { ...NO_OUTCOME, filtered: 1, errors: 1 }
    }

    const cached = await findClassification({ emailId, model: MODEL, promptVersion: PROMPT_VERSION })
    if (cached) return { ...NO_OUTCOME, filtered: 1, reused: 1 }

    let result
    try {
      result = await classify(renderForModel(msg))
    } catch {
      return { ...NO_OUTCOME, filtered: 1, errors: 1 }
    }

    // Resolve the model's chosen link marker indices to exact URLs (the model
    // never types URLs — see classify.ts / the eval).
    const urls = msg.links ?? []
    const resolvedLinks: ResolvedLink[] = result.links
      .map((l) => ({ label: l.label, url: urls[l.index - 1] }))
      .filter((l): l is ResolvedLink => Boolean(l.url))

    try {
      await insertClassification({
        emailId,
        runId: null,
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        result,
        links: resolvedLinks,
        truncated: msg.truncated,
        now: nowIso(),
      })
      return { ...NO_OUTCOME, filtered: 1, classified: 1 }
    } catch {
      return { ...NO_OUTCOME, filtered: 1, errors: 1 }
    }
  }

  // Classify concurrently (bounded). A full backfill is dozens of emails; the
  // old one-at-a-time version could exceed the function time limit.
  const outcomes = await mapLimit(emails, CLASSIFY_CONCURRENCY, processOne)

  const fetched = emails.length
  let filtered = 0
  let classified = 0
  let reused = 0
  let errors = 0
  for (const o of outcomes) {
    filtered += o.filtered
    classified += o.classified
    reused += o.reused
    errors += o.errors
  }

  // Build the digest over the same lookback window as the fetch.
  await runDigest(userId, LOOKBACK_HOURS)

  return { fetched, filtered, classified, reused, errors }
}
