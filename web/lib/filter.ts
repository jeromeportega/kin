// TS port of app/email_filters.py — the deterministic pre-filter that decides
// which emails are worth the LLM's time. Pure functions, no I/O.

export interface FetchedEmail {
  message_id: string
  uid: string | null
  from_addr: string
  subject: string
  /** ISO 8601 with offset (…+00:00), matching the stored format. */
  date: string
  text_body: string
  truncated: boolean
}

export interface FilterConfig {
  sender_allowlist: string[]
  sender_blocklist: string[]
  subject_keywords: string[]
  body_keywords: string[]
}

/** Pull the bare address out of a From header value, lowercased.
 *  "Name <a@x.com>" → "a@x.com"; "a@x.com" → "a@x.com". */
export function extractAddress(raw: string): string {
  const m = raw.match(/<([^>]+)>/)
  return (m ? m[1] : raw).trim().toLowerCase()
}

/** Exact address (`a@x.com`) or domain suffix (`@x.com`, matching subdomains too).
 *  Handles "Display Name <addr>" From headers by extracting the address first. */
export function senderMatches(addr: string, list: string[]): boolean {
  addr = extractAddress(addr)
  if (!addr || !addr.includes("@")) return false
  const domain = addr.slice(addr.lastIndexOf("@") + 1)
  for (const entry of list) {
    const e = entry.trim().toLowerCase()
    if (e.startsWith("@")) {
      const target = e.slice(1)
      if (domain === target || domain.endsWith("." + target)) return true
    } else if (addr === e) {
      return true
    }
  }
  return false
}

/** Case-insensitive substring match. Empty keyword list returns false. */
export function textContainsAny(text: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false
  const lowered = text.toLowerCase()
  return keywords.some((keyword) => lowered.includes(keyword))
}

/**
 * Loose by default (opt-out):
 * 1. Blocklisted sender → always drop.
 * 2. No allow-rules configured → classify everything, and let the model + the
 *    blocklist (built by muting in the review flow) do the triage.
 * 3. Allow-rules configured → strict mode: pass only if the sender is allowlisted
 *    or a keyword appears in the subject/body.
 */
export function shouldClassify(email: FetchedEmail, cfg: FilterConfig): boolean {
  if (senderMatches(email.from_addr, cfg.sender_blocklist)) return false

  const hasAllowRules =
    cfg.sender_allowlist.length > 0 ||
    cfg.subject_keywords.length > 0 ||
    cfg.body_keywords.length > 0
  if (!hasAllowRules) return true

  if (senderMatches(email.from_addr, cfg.sender_allowlist)) return true
  if (textContainsAny(email.subject, cfg.subject_keywords)) return true
  if (textContainsAny(email.text_body, cfg.body_keywords)) return true
  return false
}
