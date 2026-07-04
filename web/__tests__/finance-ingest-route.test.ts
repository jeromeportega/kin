import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("server-only", () => ({}))

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  resolveHouseholdScope: vi.fn(),
  importSource: vi.fn(),
  revalidatePath: vi.fn(),
}))
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }))
vi.mock("@/auth", () => ({ auth: h.auth }))
vi.mock("@/lib/finance/server", () => ({ resolveHouseholdScope: h.resolveHouseholdScope }))
vi.mock("@/lib/finance/core/ingest/pipeline", () => ({ importSource: h.importSource }))
// A chainable drizzle stand-in: no existing account, insert is a no-op.
vi.mock("@/lib/finance/db/client", () => ({
  createDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    insert: () => ({ values: () => Promise.resolve() }),
  }),
}))

import { POST } from "@/app/api/finance/ingest/route"

const req = (fields: Record<string, unknown>) =>
  ({ formData: async () => ({ get: (k: string) => fields[k] ?? null }) }) as unknown as Request

const csv = () => new File(["date,amount\n2026-07-01,-12.34"], "bank.csv", { type: "text/csv" })

beforeEach(() => {
  vi.clearAllMocks()
  h.auth.mockResolvedValue({ user: { email: "user@example.com" } })
  h.resolveHouseholdScope.mockResolvedValue({ householdId: "h1" })
  h.importSource.mockResolvedValue({ transactions: 3, orders: 0, skippedDuplicates: 1, errors: [] })
})

describe("POST /api/finance/ingest", () => {
  it("401s when unauthenticated", async () => {
    h.auth.mockResolvedValueOnce(null)
    const res = await POST(req({ file: csv(), kind: "bank" }))
    expect(res.status).toBe(401)
    expect(h.importSource).not.toHaveBeenCalled()
  })

  it("400s when no file is provided", async () => {
    const res = await POST(req({ kind: "bank" }))
    expect(res.status).toBe(400)
  })

  it("imports into the user's household and revalidates /finance", async () => {
    const res = await POST(req({ file: csv(), kind: "bank" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, transactions: 3, skippedDuplicates: 1 })
    expect(h.resolveHouseholdScope).toHaveBeenCalledWith("user@example.com")
    const [, input, ctx] = h.importSource.mock.calls[0]
    expect(input.kind).toBe("bank")
    expect(ctx.householdId).toBe("h1")
    expect(ctx.accountId).toBeTruthy() // default account created
    expect(h.revalidatePath).toHaveBeenCalledWith("/finance")
  })

  it("scopes an amazon import to the household (no account)", async () => {
    const res = await POST(req({ file: csv(), kind: "amazon" }))
    expect(res.status).toBe(200)
    const [, input, ctx] = h.importSource.mock.calls[0]
    expect(input.kind).toBe("amazon")
    expect(ctx.accountId).toBeUndefined()
  })
})
