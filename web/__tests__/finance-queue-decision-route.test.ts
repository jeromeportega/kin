import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("server-only", () => ({}))

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  resolveHouseholdScope: vi.fn(),
  recordQueueDecision: vi.fn(),
  revalidatePath: vi.fn(),
}))
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }))
vi.mock("@/auth", () => ({ auth: h.auth }))
vi.mock("@/lib/finance/server", () => ({
  resolveHouseholdScope: h.resolveHouseholdScope,
  recordQueueDecision: h.recordQueueDecision,
}))

import { POST } from "@/app/api/finance/queue/decision/route"

const jsonReq = (body: unknown) => ({ json: async () => body }) as unknown as Request

beforeEach(() => {
  vi.clearAllMocks()
  h.auth.mockResolvedValue({ user: { email: "user@example.com" } })
  h.resolveHouseholdScope.mockResolvedValue({ householdId: "h1" })
  h.recordQueueDecision.mockResolvedValue(undefined)
})

describe("POST /api/finance/queue/decision", () => {
  it("401s when unauthenticated", async () => {
    h.auth.mockResolvedValueOnce(null)
    const res = await POST(jsonReq({ itemId: "t1", itemType: "unmatched_txn", action: "confirm" }))
    expect(res.status).toBe(401)
    expect(h.recordQueueDecision).not.toHaveBeenCalled()
  })

  it("400s on an unknown item type", async () => {
    const res = await POST(jsonReq({ itemId: "t1", itemType: "nonsense", action: "confirm" }))
    expect(res.status).toBe(400)
    expect(h.recordQueueDecision).not.toHaveBeenCalled()
  })

  it("400s on an unsupported action (correct needs a payload UI)", async () => {
    const res = await POST(jsonReq({ itemId: "t1", itemType: "unmatched_txn", action: "correct" }))
    expect(res.status).toBe(400)
    expect(h.recordQueueDecision).not.toHaveBeenCalled()
  })

  it("records a confirm and revalidates /finance", async () => {
    const res = await POST(jsonReq({ itemId: "t1", itemType: "ambiguous_match", action: "confirm" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(h.recordQueueDecision).toHaveBeenCalledWith({ householdId: "h1" }, "t1", "ambiguous_match", {
      type: "confirm",
    })
    expect(h.revalidatePath).toHaveBeenCalledWith("/finance")
  })

  it("records a dismiss", async () => {
    const res = await POST(jsonReq({ itemId: "r9", itemType: "flagged_receipt", action: "dismiss" }))
    expect(res.status).toBe(200)
    expect(h.recordQueueDecision).toHaveBeenCalledWith({ householdId: "h1" }, "r9", "flagged_receipt", {
      type: "dismiss",
    })
  })
})
