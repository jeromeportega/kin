import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("server-only", () => ({}))

const h = vi.hoisted(() => {
  class ReauthRequired extends Error {}
  return {
    execute: vi.fn(),
    readRefreshToken: vi.fn(),
    mintAccessToken: vi.fn(),
    fetchRecent: vi.fn(),
    classify: vi.fn(),
    upsertEmail: vi.fn(),
    findClassification: vi.fn(),
    insertClassification: vi.fn(),
    runDigest: vi.fn(),
    ReauthRequired,
  }
})

vi.mock("@/lib/digest", () => ({ runDigest: h.runDigest }))

vi.mock("@/lib/db", () => ({ dbClient: () => ({ execute: h.execute }) }))
vi.mock("@/lib/tokenStore", () => ({ readRefreshToken: h.readRefreshToken }))
vi.mock("@/lib/gmail", () => ({
  mintAccessToken: h.mintAccessToken,
  fetchRecent: h.fetchRecent,
  ReauthRequired: h.ReauthRequired,
}))
vi.mock("@/lib/classify", () => ({ classify: h.classify, MODEL: "m", PROMPT_VERSION: "v" }))
vi.mock("@/lib/writes", () => ({
  upsertEmail: h.upsertEmail,
  findClassification: h.findClassification,
  insertClassification: h.insertClassification,
}))

import { runIngest } from "@/lib/ingest"

const email = (over = {}) => ({
  message_id: "<a>",
  uid: "1",
  from_addr: "a@x.com",
  subject: "Hi",
  date: "2026-01-01T00:00:00+00:00",
  text_body: "body",
  truncated: false,
  ...over,
})
const RESULT = {
  category: "finance",
  priority: "high",
  action_required: true,
  summary: "s",
  action_items: [],
  dates: [],
  links: [],
  events: [],
  confidence: 0.9,
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.GOOGLE_CLIENT_ID = "id"
  process.env.GOOGLE_CLIENT_SECRET = "sec"
  h.execute.mockResolvedValue({ rows: [{ kind: "sender_allowlist", value: "a@x.com" }] })
  h.readRefreshToken.mockResolvedValue("rt")
  h.mintAccessToken.mockResolvedValue("token")
  h.upsertEmail.mockResolvedValue(1)
  h.findClassification.mockResolvedValue(null)
  h.classify.mockResolvedValue(RESULT)
  h.insertClassification.mockResolvedValue(7)
})

describe("runIngest", () => {
  it("classifies a new allowlisted email", async () => {
    h.fetchRecent.mockResolvedValueOnce([email()])
    const r = await runIngest("u")
    expect(r).toEqual({ fetched: 1, filtered: 1, classified: 1, reused: 0, errors: 0 })
    expect(h.classify).toHaveBeenCalledOnce()
    expect(h.insertClassification).toHaveBeenCalledOnce()
  })

  it("resolves the model's chosen link index to the exact URL", async () => {
    h.fetchRecent.mockResolvedValueOnce([
      email({ links: ["https://calendly.com/x", "https://acme.com/unsub"] }),
    ])
    h.classify.mockResolvedValueOnce({ ...RESULT, links: [{ label: "Schedule", index: 1 }] })
    await runIngest("u")
    expect(h.insertClassification.mock.calls[0][0].links).toEqual([
      { label: "Schedule", url: "https://calendly.com/x" },
    ])
  })

  it("drops a link index that doesn't resolve to a URL", async () => {
    h.fetchRecent.mockResolvedValueOnce([email({ links: ["https://a.com"] })])
    h.classify.mockResolvedValueOnce({ ...RESULT, links: [{ label: "X", index: 9 }] })
    await runIngest("u")
    expect(h.insertClassification.mock.calls[0][0].links).toEqual([])
  })

  it("passes extracted calendar events through to persistence", async () => {
    h.fetchRecent.mockResolvedValueOnce([email()])
    const events = [{ title: "Dentist", start: "2026-07-10T14:00:00+00:00", end: null }]
    h.classify.mockResolvedValueOnce({ ...RESULT, events })
    await runIngest("u")
    expect(h.insertClassification.mock.calls[0][0].result.events).toEqual(events)
  })

  it("filters out a non-allowlisted email", async () => {
    h.fetchRecent.mockResolvedValueOnce([email({ from_addr: "b@y.com" })])
    const r = await runIngest("u")
    expect(r).toEqual({ fetched: 1, filtered: 0, classified: 0, reused: 0, errors: 0 })
    expect(h.classify).not.toHaveBeenCalled()
  })

  it("reuses a cached classification", async () => {
    h.fetchRecent.mockResolvedValueOnce([email()])
    h.findClassification.mockResolvedValueOnce(RESULT)
    const r = await runIngest("u")
    expect(r.reused).toBe(1)
    expect(r.classified).toBe(0)
    expect(h.classify).not.toHaveBeenCalled()
  })

  it("counts a classify error and continues", async () => {
    h.fetchRecent.mockResolvedValueOnce([email(), email({ message_id: "<b>" })])
    h.classify.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(RESULT)
    const r = await runIngest("u")
    expect(r.errors).toBe(1)
    expect(r.classified).toBe(1)
  })

  it("throws ReauthRequired when there is no refresh token", async () => {
    h.readRefreshToken.mockResolvedValueOnce(null)
    await expect(runIngest("u")).rejects.toBeInstanceOf(h.ReauthRequired)
  })
})
