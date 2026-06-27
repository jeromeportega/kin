import type { Classification } from "@/lib/types"
import type { KinConfig } from "@/lib/kinConfig"

// A sender we've classified mail from but the user hasn't told us about yet
// (not in the allowlist or blocklist). The tuning UI surfaces these so the user
// can okay or mute them. When this list is empty, the config covers what's
// arriving and the tuning prompt hides itself — the data-derived cadence.
export interface UnfamiliarSender {
  address: string
  domain: string
  count: number
  sampleSubject: string
  sampleCategory: string
  sampleSummary: string
  latest: string
}

export function extractEmail(from: string): string {
  const m = from.match(/<([^>]+)>/)
  return (m ? m[1] : from).trim().toLowerCase()
}

export function unfamiliarSenders(
  classifications: Classification[],
  config: KinConfig,
  limit = 10
): UnfamiliarSender[] {
  const knownAddrs = new Set<string>()
  const knownDomains = new Set<string>()
  for (const entry of [...config.sender_allowlist, ...config.sender_blocklist]) {
    const e = entry.trim().toLowerCase()
    if (!e) continue
    if (e.startsWith("@")) knownDomains.add(e.slice(1))
    else knownAddrs.add(e)
  }
  const domainKnown = (domain: string) => {
    for (const d of knownDomains) {
      if (domain === d || domain.endsWith(`.${d}`)) return true
    }
    return false
  }

  const byAddr = new Map<string, UnfamiliarSender>()
  for (const c of classifications) {
    const address = extractEmail(c.from_addr)
    const domain = address.split("@")[1] ?? ""
    if (knownAddrs.has(address) || (domain && domainKnown(domain))) continue

    const existing = byAddr.get(address)
    if (existing) {
      existing.count += 1
      if (c.email_date > existing.latest) {
        existing.latest = c.email_date
        existing.sampleSubject = c.subject
        existing.sampleCategory = c.category
        existing.sampleSummary = c.summary
      }
    } else {
      byAddr.set(address, {
        address,
        domain,
        count: 1,
        sampleSubject: c.subject,
        sampleCategory: c.category,
        sampleSummary: c.summary,
        latest: c.email_date,
      })
    }
  }

  return [...byAddr.values()]
    .sort((a, b) => b.count - a.count || b.latest.localeCompare(a.latest))
    .slice(0, limit)
}
