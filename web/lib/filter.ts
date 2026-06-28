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

/** Exact address (`a@x.com`) or domain suffix (`@x.com`, matching subdomains too). */
export function senderMatches(addr: string, allowlist: string[]): boolean {
  addr = addr.trim().toLowerCase()
  if (!addr || !addr.includes("@")) return false
  const domain = addr.slice(addr.lastIndexOf("@") + 1)
  for (const entry of allowlist) {
    if (entry.startsWith("@")) {
      const target = entry.slice(1)
      if (domain === target || domain.endsWith("." + target)) return true
    } else if (addr === entry) {
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
 * 1. Blocklisted sender → drop.
 * 2. Otherwise pass if the sender is allowlisted, or a configured keyword
 *    appears in the subject or body.
 */
export function shouldClassify(email: FetchedEmail, cfg: FilterConfig): boolean {
  if (senderMatches(email.from_addr, cfg.sender_blocklist)) return false
  if (senderMatches(email.from_addr, cfg.sender_allowlist)) return true
  if (textContainsAny(email.subject, cfg.subject_keywords)) return true
  if (textContainsAny(email.text_body, cfg.body_keywords)) return true
  return false
}
