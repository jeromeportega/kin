import { describe, it, expect } from "vitest"
import { unfamiliarSenders, extractEmail, suggestKeywords } from "@/lib/tuning"
import type { Classification } from "@/lib/types"
import type { KinConfig } from "@/lib/kinConfig"

function c(over: Partial<Classification>): Classification {
  return {
    classification_id: 1,
    model: "m",
    prompt_version: "v",
    category: "other",
    priority: "low",
    action_required: false,
    summary: "s",
    action_items: [],
    dates: [],
    links: [],
    confidence: 0.9,
    classified_at: "2026-06-26T12:00:00+00:00",
    email_id: 1,
    message_id: "<a@x>",
    uid: "1",
    folder: "INBOX",
    from_addr: "a@example.com",
    subject: "subj",
    email_date: "2026-06-26T10:00:00+00:00",
    ...over,
  }
}

const empty: KinConfig = { sender_allowlist: [], sender_blocklist: [], subject_keywords: [] }

describe("extractEmail", () => {
  it("parses bare and Name <addr> forms, lowercased", () => {
    expect(extractEmail("Alice <A@X.com>")).toBe("a@x.com")
    expect(extractEmail("b@y.com")).toBe("b@y.com")
  })
})

describe("unfamiliarSenders", () => {
  it("returns distinct senders not in the config", () => {
    const r = unfamiliarSenders([c({ from_addr: "a@x.com" }), c({ from_addr: "b@y.com" })], empty)
    expect(r.map((s) => s.address).sort()).toEqual(["a@x.com", "b@y.com"])
  })

  it("excludes allowlisted addresses and blocklisted addresses", () => {
    const cfg: KinConfig = { ...empty, sender_allowlist: ["a@x.com"], sender_blocklist: ["b@y.com"] }
    const r = unfamiliarSenders(
      [c({ from_addr: "a@x.com" }), c({ from_addr: "b@y.com" }), c({ from_addr: "c@z.com" })],
      cfg
    )
    expect(r.map((s) => s.address)).toEqual(["c@z.com"])
  })

  it("excludes domain-allowlisted senders including subdomains", () => {
    const cfg: KinConfig = { ...empty, sender_allowlist: ["@delta.com"] }
    const r = unfamiliarSenders(
      [c({ from_addr: "x@delta.com" }), c({ from_addr: "y@notify.delta.com" }), c({ from_addr: "z@other.com" })],
      cfg
    )
    expect(r.map((s) => s.address)).toEqual(["z@other.com"])
  })

  it("groups by address, counts, and keeps the newest sample", () => {
    const r = unfamiliarSenders(
      [
        c({ from_addr: "a@x.com", subject: "old", email_date: "2026-06-20T00:00:00+00:00" }),
        c({ from_addr: "a@x.com", subject: "new", email_date: "2026-06-25T00:00:00+00:00" }),
      ],
      empty
    )
    expect(r).toHaveLength(1)
    expect(r[0].count).toBe(2)
    expect(r[0].sampleSubject).toBe("new")
  })

  it("respects the limit", () => {
    const many = Array.from({ length: 15 }, (_, i) => c({ from_addr: `s${i}@x.com` }))
    expect(unfamiliarSenders(many, empty, 10)).toHaveLength(10)
  })
})

describe("suggestKeywords", () => {
  it("ranks notable subject terms by frequency, dropping stopwords", () => {
    const r = suggestKeywords(
      [
        c({ subject: "Pediatrician appointment confirmed" }),
        c({ subject: "Pediatrician visit summary" }),
        c({ subject: "Your weekly newsletter" }),
      ],
      empty
    )
    expect(r[0]).toBe("pediatrician") // appears in 2 emails
    expect(r).not.toContain("your") // stopword
    expect(r).not.toContain("summary") // stopword
  })

  it("excludes terms already in the config and respects the limit", () => {
    const cfg = { ...empty, subject_keywords: ["invoice"] }
    const r = suggestKeywords(
      [c({ subject: "invoice payment tuition daycare" })],
      cfg,
      2
    )
    expect(r).not.toContain("invoice")
    expect(r.length).toBeLessThanOrEqual(2)
  })
})
