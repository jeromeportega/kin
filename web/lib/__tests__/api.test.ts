import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("server-only", () => ({}))

const execute = vi.fn()
vi.mock("@/lib/db", () => ({ dbClient: () => ({ execute }) }))

import { fetchDigest, fetchClassifications } from "@/lib/api"
import type { Digest } from "@/lib/types"

beforeEach(() => {
  execute.mockReset()
})

function digest(itemCount = 1): Digest {
  return {
    generated_at: "2026-01-01T00:00:00+00:00",
    user_id: "jerome",
    model: "m",
    prompt_version: "v1",
    window_hours: 24,
    window_start: "2025-12-31T00:00:00+00:00",
    window_end: "2026-01-01T00:00:00+00:00",
    include_other: false,
    classified_count: itemCount,
    actionable_count: itemCount,
    informational_count: 0,
    skipped_other_count: 0,
    dropped_low_count: 0,
    items: Array.from({ length: itemCount }, (_, i) => ({
      classification_id: i + 1,
      message_id: `msg-${i}`,
      uid: null,
      from_addr: "sender@example.com",
      subject: "Test",
      date: "2026-01-01T00:00:00+00:00",
      category: "work",
      priority: "high",
      action_required: true,
      summary: "A test email",
      action_items: ["Reply"],
      dates: [],
      confidence: 0.9,
      model: "m",
      prompt_version: "v1",
      classified_at: "2026-01-01T00:00:00+00:00",
    })),
  }
}

describe("fetchDigest", () => {
  it("returns the parsed digest from json_payload", async () => {
    execute.mockResolvedValueOnce({ rows: [{ json_payload: JSON.stringify(digest(2)) }] })
    const result = await fetchDigest("jerome")
    expect(result?.items).toHaveLength(2)
    expect(result?.user_id).toBe("jerome")
  })

  it("returns null when there is no digest row", async () => {
    execute.mockResolvedValueOnce({ rows: [] })
    expect(await fetchDigest("jerome")).toBeNull()
  })

  it("returns null when the digest has no items", async () => {
    execute.mockResolvedValueOnce({ rows: [{ json_payload: JSON.stringify(digest(0)) }] })
    expect(await fetchDigest("jerome")).toBeNull()
  })

  it("queries scoped to the user_id and the 24h window", async () => {
    execute.mockResolvedValueOnce({ rows: [] })
    await fetchDigest("jerome+test")
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ args: ["jerome+test", 24] }))
  })

  it("throws when userId is empty", async () => {
    await expect(fetchDigest("")).rejects.toThrow("userId is required")
  })
})

describe("fetchClassifications", () => {
  const row = {
    classification_id: 1,
    model: "m",
    prompt_version: "v1",
    category: "work",
    priority: "high",
    action_required: 1,
    summary: "s",
    action_items: "[]",
    dates: '["2026-01-02"]',
    confidence: 0.9,
    classified_at: "2026-01-01T00:00:00+00:00",
    email_id: 42,
    message_id: "msg",
    uid: null,
    folder: "INBOX",
    from_addr: "a@x.com",
    subject: "Hi",
    email_date: "2026-01-01T00:00:00+00:00",
  }

  it("maps DB rows to Classification[]", async () => {
    execute.mockResolvedValueOnce({ rows: [row] })
    const r = await fetchClassifications("jerome", 24)
    expect(r).toHaveLength(1)
    expect(r[0].from_addr).toBe("a@x.com")
    expect(r[0].action_required).toBe(true)
    expect(r[0].action_items).toEqual([])
    expect(r[0].dates).toEqual(["2026-01-02"])
    expect(r[0].uid).toBeNull()
  })

  it("returns an empty array when there are no rows", async () => {
    execute.mockResolvedValueOnce({ rows: [] })
    expect(await fetchClassifications("jerome", 24)).toEqual([])
  })

  it("passes the user_id and +00:00 window bounds as args", async () => {
    execute.mockResolvedValueOnce({ rows: [] })
    await fetchClassifications("jerome", 24)
    const args = execute.mock.calls[0][0].args as unknown[]
    expect(args[0]).toBe("jerome")
    expect(args[1]).toMatch(/\+00:00$/)
    expect(args[2]).toMatch(/\+00:00$/)
  })

  it("rejects non-positive or fractional hours", async () => {
    await expect(fetchClassifications("jerome", 0)).rejects.toThrow("positive integer")
    await expect(fetchClassifications("jerome", -1)).rejects.toThrow("positive integer")
    await expect(fetchClassifications("jerome", 1.5)).rejects.toThrow("positive integer")
  })

  it("throws when userId is empty", async () => {
    await expect(fetchClassifications("", 24)).rejects.toThrow("userId is required")
  })
})
