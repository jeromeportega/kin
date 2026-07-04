import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("server-only", () => ({}))

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  resolveHouseholdScope: vi.fn(),
  plaidConfigured: vi.fn(),
  createLinkToken: vi.fn(),
  exchangeAndSync: vi.fn(),
  syncHousehold: vi.fn(),
  revalidatePath: vi.fn(),
}))
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }))
vi.mock("@/auth", () => ({ auth: h.auth }))
vi.mock("@/lib/finance/server", () => ({ resolveHouseholdScope: h.resolveHouseholdScope }))
vi.mock("@/lib/finance/plaid/client", () => ({ plaidConfigured: h.plaidConfigured }))
vi.mock("@/lib/finance/plaid/server", () => ({
  createLinkToken: h.createLinkToken,
  exchangeAndSync: h.exchangeAndSync,
  syncHousehold: h.syncHousehold,
}))

import { POST as linkToken } from "@/app/api/finance/plaid/link-token/route"
import { POST as exchange } from "@/app/api/finance/plaid/exchange/route"
import { POST as sync } from "@/app/api/finance/plaid/sync/route"

const jsonReq = (body: unknown) =>
  ({ json: async () => body }) as unknown as Request

beforeEach(() => {
  vi.clearAllMocks()
  h.auth.mockResolvedValue({ user: { email: "user@example.com" } })
  h.resolveHouseholdScope.mockResolvedValue({ householdId: "h1" })
  h.plaidConfigured.mockReturnValue(true)
  h.createLinkToken.mockResolvedValue("link-sandbox-abc")
  h.exchangeAndSync.mockResolvedValue({ added: 5, skippedDuplicates: 0 })
  h.syncHousehold.mockResolvedValue({ added: 2, skippedDuplicates: 3 })
})

describe("plaid routes — auth + config guards", () => {
  it("link-token 401s when unauthenticated", async () => {
    h.auth.mockResolvedValueOnce(null)
    expect((await linkToken()).status).toBe(401)
    expect(h.createLinkToken).not.toHaveBeenCalled()
  })

  it("link-token 503s when Plaid is not configured", async () => {
    h.plaidConfigured.mockReturnValueOnce(false)
    expect((await linkToken()).status).toBe(503)
    expect(h.createLinkToken).not.toHaveBeenCalled()
  })

  it("link-token returns a link_token for the user's household", async () => {
    const res = await linkToken()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ link_token: "link-sandbox-abc" })
    expect(h.createLinkToken).toHaveBeenCalledWith({ householdId: "h1" })
  })
})

describe("plaid exchange route", () => {
  it("400s when public_token is missing", async () => {
    const res = await exchange(jsonReq({}))
    expect(res.status).toBe(400)
    expect(h.exchangeAndSync).not.toHaveBeenCalled()
  })

  it("exchanges + syncs, forwards institution metadata, revalidates", async () => {
    const res = await exchange(
      jsonReq({ public_token: "public-sandbox-1", institution: { id: "ins_1", name: "Chase" } }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, added: 5 })
    expect(h.exchangeAndSync).toHaveBeenCalledWith({ householdId: "h1" }, "public-sandbox-1", {
      id: "ins_1",
      name: "Chase",
    })
    expect(h.revalidatePath).toHaveBeenCalledWith("/finance")
  })
})

describe("plaid sync route", () => {
  it("401s when unauthenticated", async () => {
    h.auth.mockResolvedValueOnce(null)
    expect((await sync()).status).toBe(401)
    expect(h.syncHousehold).not.toHaveBeenCalled()
  })

  it("syncs the household and revalidates", async () => {
    const res = await sync()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, added: 2, skippedDuplicates: 3 })
    expect(h.syncHousehold).toHaveBeenCalledWith({ householdId: "h1" })
    expect(h.revalidatePath).toHaveBeenCalledWith("/finance")
  })
})
