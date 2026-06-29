import { describe, it, expect } from "vitest"
import {
  senderMatches,
  textContainsAny,
  shouldClassify,
  type FetchedEmail,
  type FilterConfig,
} from "@/lib/filter"

const email = (over: Partial<FetchedEmail> = {}): FetchedEmail => ({
  message_id: "<a@x>",
  uid: "1",
  from_addr: "a@x.com",
  subject: "Hi",
  date: "2026-01-01T00:00:00+00:00",
  text_body: "body",
  truncated: false,
  ...over,
})

const cfg = (over: Partial<FilterConfig> = {}): FilterConfig => ({
  sender_allowlist: [],
  sender_blocklist: [],
  subject_keywords: [],
  body_keywords: [],
  ...over,
})

describe("senderMatches", () => {
  it("matches exact addresses", () => {
    expect(senderMatches("a@x.com", ["a@x.com"])).toBe(true)
    expect(senderMatches("b@x.com", ["a@x.com"])).toBe(false)
  })
  it("matches domain suffixes including subdomains", () => {
    expect(senderMatches("x@delta.com", ["@delta.com"])).toBe(true)
    expect(senderMatches("y@notify.delta.com", ["@delta.com"])).toBe(true)
    expect(senderMatches("z@other.com", ["@delta.com"])).toBe(false)
  })
  it("is case-insensitive and rejects non-addresses", () => {
    expect(senderMatches("A@X.com", ["a@x.com"])).toBe(true)
    expect(senderMatches("not-an-email", ["a@x.com"])).toBe(false)
  })
})

describe("textContainsAny", () => {
  it("does a case-insensitive substring match; empty list is false", () => {
    expect(textContainsAny("Your Bill", ["bill"])).toBe(true)
    expect(textContainsAny("hello", [])).toBe(false)
  })
})

describe("shouldClassify", () => {
  it("drops a blocklisted sender before anything else", () => {
    const c = cfg({ sender_blocklist: ["spam@x.com"], sender_allowlist: ["spam@x.com"] })
    expect(shouldClassify(email({ from_addr: "spam@x.com" }), c)).toBe(false)
  })
  it("loose by default: classifies everything when no allow-rules are set", () => {
    expect(shouldClassify(email(), cfg())).toBe(true)
  })
  it("loose mode still drops blocklisted senders", () => {
    const c = cfg({ sender_blocklist: ["spam@x.com"] })
    expect(shouldClassify(email({ from_addr: "spam@x.com" }), c)).toBe(false)
  })
  it("strict mode (allow-rules set) passes an allowlisted sender", () => {
    expect(shouldClassify(email(), cfg({ sender_allowlist: ["a@x.com"] }))).toBe(true)
  })
  it("strict mode passes on a subject keyword", () => {
    expect(shouldClassify(email({ subject: "Invoice 12" }), cfg({ subject_keywords: ["invoice"] }))).toBe(true)
  })
  it("strict mode passes on a body keyword", () => {
    expect(shouldClassify(email({ text_body: "tuition due" }), cfg({ body_keywords: ["tuition"] }))).toBe(true)
  })
  it("strict mode drops a non-matching email once allow-rules exist", () => {
    const c = cfg({ sender_allowlist: ["a@x.com"] })
    expect(shouldClassify(email({ from_addr: "nobody@z.com", subject: "x", text_body: "y" }), c)).toBe(false)
  })
})
