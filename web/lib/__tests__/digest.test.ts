import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("server-only", () => ({}))

const execute = vi.fn()
vi.mock("@/lib/db", () => ({ dbClient: () => ({ execute }) }))
vi.mock("@/lib/api", () => ({ fetchClassifications: vi.fn() }))
vi.mock("@/lib/classify", () => ({ MODEL: "m", PROMPT_VERSION: "v" }))

import { buildDigest, renderMarkdown, insertDigest } from "@/lib/digest"
import type { Classification } from "@/lib/types"

const cls = (over: Partial<Classification> = {}): Classification => ({
  classification_id: 1,
  model: "m",
  prompt_version: "v",
  category: "finance",
  priority: "high",
  action_required: true,
  summary: "s",
  action_items: [],
  dates: [],
  confidence: 0.9,
  classified_at: "2026-01-01T00:00:00+00:00",
  email_id: 1,
  message_id: "<a>",
  uid: "1",
  folder: "INBOX",
  from_addr: "a@x.com",
  subject: "Hi",
  email_date: "2026-01-01T00:00:00+00:00",
  ...over,
})

const now = new Date("2026-01-02T00:00:00Z")

beforeEach(() => execute.mockReset())

describe("buildDigest", () => {
  it("shows high/medium, keeps low-actionable, drops low-FYI, counts other", () => {
    const rows = [
      cls({ classification_id: 1, priority: "high", action_required: true }),
      cls({ classification_id: 2, priority: "medium", action_required: false }),
      cls({ classification_id: 3, priority: "low", action_required: false }), // dropped
      cls({ classification_id: 4, priority: "low", action_required: true }), // shown
      cls({ classification_id: 5, category: "other", priority: "high" }), // skipped
    ]
    const d = buildDigest(rows, { userId: "u", hours: 24, now, includeOther: false })
    expect(d.classified_count).toBe(5)
    expect(d.skipped_other_count).toBe(1)
    expect(d.dropped_low_count).toBe(1)
    expect(d.actionable_count).toBe(2)
    expect(d.informational_count).toBe(1)
    expect(d.items.map((i) => i.classification_id)).toEqual([1, 2, 4]) // high → medium → low
    expect(d.items.length).toBe(d.actionable_count + d.informational_count) // invariant
  })

  it("includes other items when includeOther is true", () => {
    const d = buildDigest([cls({ category: "other", priority: "high" })], {
      userId: "u",
      hours: 24,
      now,
      includeOther: true,
    })
    expect(d.skipped_other_count).toBe(1)
    expect(d.items).toHaveLength(1)
  })
})

describe("renderMarkdown", () => {
  it("renders a header, summary, and section", () => {
    const d = buildDigest([cls({ priority: "high", subject: "Pay bill" })], {
      userId: "u",
      hours: 24,
      now,
      includeOther: false,
    })
    const md = renderMarkdown(d)
    expect(md).toContain("# kin daily digest")
    expect(md).toContain("High priority")
    expect(md).toContain("Pay bill")
  })
})

describe("insertDigest", () => {
  it("inserts the digest + items and returns the id", async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: 11 }] }).mockResolvedValue({})
    const d = buildDigest([cls({ priority: "high", action_required: true })], {
      userId: "u",
      hours: 24,
      now,
      includeOther: false,
    })
    const id = await insertDigest(d, { markdown: "md", jsonPayload: "{}", classificationIds: [1] })
    expect(id).toBe(11)
    expect(execute).toHaveBeenCalledTimes(2) // 1 digest + 1 item
  })

  it("throws on a counter mismatch", async () => {
    const d = buildDigest([cls({ priority: "high", action_required: true })], {
      userId: "u",
      hours: 24,
      now,
      includeOther: false,
    })
    await expect(
      insertDigest(d, { markdown: "m", jsonPayload: "{}", classificationIds: [1, 2] })
    ).rejects.toThrow(/counter mismatch/)
  })
})
