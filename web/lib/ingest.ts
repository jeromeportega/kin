import "server-only"
import { dbClient } from "./db"
import { readRefreshToken } from "./tokenStore"
import { mintAccessToken, fetchRecent, ReauthRequired } from "./gmail"
import { shouldClassify, type FetchedEmail, type FilterConfig } from "./filter"
import { classify, MODEL, PROMPT_VERSION } from "./classify"
import { upsertEmail, findClassification, insertClassification } from "./writes"
import { runDigest } from "./digest"

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
  const hours = opts.hours ?? 24
  const limit = opts.limit ?? 50

  const cfg = await readFilterConfig(userId)

  const refreshToken = await readRefreshToken(userId)
  if (!refreshToken) throw new ReauthRequired(`no refresh token for ${userId}`)
  const { clientId, clientSecret } = googleCreds()
  const accessToken = await mintAccessToken(refreshToken, clientId, clientSecret)

  const emails = await fetchRecent({ accessToken, hours, limit })

  let fetched = 0
  let filtered = 0
  let classified = 0
  let reused = 0
  let errors = 0

  for (const msg of emails) {
    fetched += 1
    if (!shouldClassify(msg, cfg)) continue
    filtered += 1

    let emailId: number
    try {
      emailId = await upsertEmail({ userId, folder: "INBOX", msg, now: nowIso() })
    } catch {
      errors += 1
      continue
    }

    const cached = await findClassification({ emailId, model: MODEL, promptVersion: PROMPT_VERSION })
    if (cached) {
      reused += 1
      continue
    }

    let result
    try {
      result = await classify(renderForModel(msg))
    } catch {
      errors += 1
      continue
    }

    try {
      await insertClassification({
        emailId,
        runId: null,
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        result,
        truncated: msg.truncated,
        now: nowIso(),
      })
      classified += 1
    } catch {
      errors += 1
    }
  }

  // Build the daily digest from the freshly-persisted classifications.
  await runDigest(userId, 24)

  return { fetched, filtered, classified, reused, errors }
}
