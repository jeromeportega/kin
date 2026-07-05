import "server-only"
import type { FetchedEmail } from "./filter"

// TS port of ingest/oauth.py + ingest/gmail_source.py. Both the OAuth token
// refresh and the Gmail REST calls are plain fetch() — no googleapis SDK.

const TOKEN_URL = "https://oauth2.googleapis.com/token"
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"
const MAX_BODY_CHARS = 4000

/** Raised when the refresh token has been revoked or has expired. */
export class ReauthRequired extends Error {}

/** Mint a short-lived Gmail access token from a stored refresh token. */
export async function mintAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    // invalid_grant (revoked/expired) comes back as 400/401.
    if (res.status === 400 || res.status === 401) {
      throw new ReauthRequired(`token refresh failed: ${res.status} ${body}`)
    }
    throw new Error(`token refresh failed: ${res.status} ${body}`)
  }
  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

interface GmailPayload {
  mimeType?: string
  headers?: { name: string; value: string }[]
  body?: { data?: string }
  parts?: GmailPayload[]
}
interface GmailMessage {
  id: string
  internalDate?: string
  payload?: GmailPayload
}

export function decodeB64Url(data: string): string {
  if (!data) return ""
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
}

export function stripHtml(html: string): string {
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

// Parse the plain-text alternative's "label ( url )" form (what most senders emit,
// and what the eval cases use) into [n] markers + the URL list. Mirrors
// app/links.py render_with_links so the classifier sees the same shape in eval and
// in production. The classifier returns a marker index; we resolve it to the URL.
function markPlainLinks(text: string): [string, string[]] {
  const urls: string[] = []
  const marked = text.replace(/\(\s*(https?:\/\/[^\s)]+)\s*\)/g, (_m, url: string) => {
    urls.push(url)
    return `[${urls.length}]`
  })
  return [marked, urls]
}

// Fallback for HTML-only emails: pull <a href> links into "label [n]" markers,
// then strip the remaining tags.
function markHtmlLinks(html: string): [string, string[]] {
  const urls: string[] = []
  const withMarkers = html.replace(
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, url: string, inner: string) => {
      const label = inner
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
      urls.push(url)
      return ` ${label} [${urls.length}] `
    }
  )
  return [stripHtml(withMarkers), urls]
}

/** Body text with [n] link markers + the URLs for those markers, by index. */
export function renderBodyWithLinks(plain: string, html: string): [string, string[]] {
  if (plain) return markPlainLinks(plain)
  if (html) return markHtmlLinks(html)
  return ["", []]
}

function extractParts(payload: GmailPayload): [string, string] {
  const mime = payload.mimeType ?? ""
  if (mime === "text/plain") return [payload.body?.data ? decodeB64Url(payload.body.data) : "", ""]
  if (mime === "text/html") return ["", payload.body?.data ? decodeB64Url(payload.body.data) : ""]
  let plain = ""
  let html = ""
  for (const part of payload.parts ?? []) {
    const [p, h] = extractParts(part)
    if (!plain && p) plain = p
    if (!html && h) html = h
  }
  return [plain, html]
}

function header(headers: { name: string; value: string }[], name: string): string {
  const lc = name.toLowerCase()
  return headers.find((h) => h.name.toLowerCase() === lc)?.value ?? ""
}

/** Parse the Date header (RFC 2822) → ISO 8601 UTC (…+00:00). Falls back to internalDate, then now. */
function parseDateIso(raw: string, internalMs: string): string {
  let d: Date | null = null
  if (raw) {
    const t = new Date(raw)
    if (!Number.isNaN(t.getTime())) d = t
  }
  if (!d && internalMs) {
    const ms = Number(internalMs)
    if (Number.isFinite(ms)) d = new Date(ms)
  }
  if (!d) d = new Date()
  return d.toISOString().replace("Z", "+00:00")
}

function toFetched(msg: GmailMessage): FetchedEmail {
  const payload = msg.payload ?? {}
  const headers = payload.headers ?? []
  const [plain, html] = extractParts(payload)
  const [rawBody, links] = renderBodyWithLinks(plain, html)
  const truncated = rawBody.length > MAX_BODY_CHARS
  const textBody = truncated ? rawBody.slice(0, MAX_BODY_CHARS) : rawBody

  let messageId = header(headers, "Message-ID").trim()
  if (!messageId) messageId = `<gmail-${msg.id}@mail.gmail.com>`

  return {
    uid: msg.id,
    message_id: messageId,
    from_addr: header(headers, "From").toLowerCase(),
    subject: header(headers, "Subject"),
    date: parseDateIso(header(headers, "Date"), msg.internalDate ?? ""),
    text_body: textBody,
    truncated,
    links,
  }
}

/** A raw RFC822 message from Gmail with its stable message id. */
export interface RawGmailMessage {
  messageId: string  // stable Gmail id (messages.list / messages.get `id`)
  bytes: Uint8Array  // raw RFC822, base64url-decoded from messages.get?format=raw
}

/**
 * Fetch raw RFC822 bytes for Gmail messages matching a sender/subject query.
 * The caller is responsible for constructing `query` (e.g. `emlGmailQuery()`).
 * Never imports from the finance module — purely a Gmail I/O helper.
 */
export async function fetchRawMessages(opts: {
  accessToken: string
  query: string
  limit: number
}): Promise<RawGmailMessage[]> {
  const { accessToken, query, limit } = opts
  if (limit <= 0) return []

  const auth = { Authorization: `Bearer ${accessToken}` }

  const listUrl =
    `${GMAIL_API}/messages?q=${encodeURIComponent(query)}&maxResults=${limit}`
  const listRes = await fetch(listUrl, { headers: auth })
  if (!listRes.ok) throw new Error(`Gmail list failed: ${listRes.status}`)
  const list = (await listRes.json()) as { messages?: { id: string }[] }

  const out: RawGmailMessage[] = []
  for (const ref of list.messages ?? []) {
    const getRes = await fetch(`${GMAIL_API}/messages/${ref.id}?format=raw`, { headers: auth })
    if (getRes.status === 404) continue
    if (!getRes.ok) throw new Error(`Gmail get failed: ${getRes.status}`)
    const msg = (await getRes.json()) as { id: string; raw: string }
    const bytes = Buffer.from(msg.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64")
    out.push({ messageId: msg.id, bytes: new Uint8Array(bytes) })
  }
  return out
}

/** Fetch recent INBOX messages from Gmail, mapped to FetchedEmail. */
export async function fetchRecent(opts: {
  accessToken: string
  hours: number
  limit: number
  folder?: string
}): Promise<FetchedEmail[]> {
  const { accessToken, hours, limit, folder = "INBOX" } = opts
  const cutoff = Math.floor((Date.now() - hours * 3_600_000) / 1000)
  const auth = { Authorization: `Bearer ${accessToken}` }

  const listUrl =
    `${GMAIL_API}/messages?labelIds=${encodeURIComponent(folder)}` +
    `&q=${encodeURIComponent(`after:${cutoff}`)}&maxResults=${limit}`
  const listRes = await fetch(listUrl, { headers: auth })
  if (!listRes.ok) throw new Error(`Gmail list failed: ${listRes.status}`)
  const list = (await listRes.json()) as { messages?: { id: string }[] }

  const out: FetchedEmail[] = []
  for (const ref of list.messages ?? []) {
    const getRes = await fetch(`${GMAIL_API}/messages/${ref.id}?format=full`, { headers: auth })
    if (getRes.status === 404) continue // deleted between list and get
    if (!getRes.ok) throw new Error(`Gmail get failed: ${getRes.status}`)
    out.push(toFetched((await getRes.json()) as GmailMessage))
  }
  return out
}
