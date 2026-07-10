import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("server-only", () => ({}))

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  resolveHouseholdScope: vi.fn(),
  scanReceipt: vi.fn(),
  receiptScanConfigured: vi.fn(),
  revalidatePath: vi.fn(),
}))
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }))
vi.mock("@/auth", () => ({ auth: h.auth }))
vi.mock("@/lib/finance/server", () => ({ resolveHouseholdScope: h.resolveHouseholdScope }))
vi.mock("@/lib/finance/receipts/server", () => ({
  scanReceipt: h.scanReceipt,
  receiptScanConfigured: h.receiptScanConfigured,
}))

import { POST } from "@/app/api/finance/receipts/scan/route"

const req = (file?: File) =>
  ({ formData: async () => ({ get: (k: string) => (k === "file" ? file ?? null : null) }) }) as unknown as Request
const jpeg = () => new File([new Uint8Array([1, 2, 3])], "receipt.jpg", { type: "image/jpeg" })

beforeEach(() => {
  vi.clearAllMocks()
  h.auth.mockResolvedValue({ user: { email: "user@example.com" } })
  h.resolveHouseholdScope.mockResolvedValue({ householdId: "h1" })
  h.receiptScanConfigured.mockReturnValue(true)
  h.scanReceipt.mockResolvedValue({
    store: "Costco Wholesale",
    totalCents: 9786,
    itemCount: 1,
    status: "ok",
    idempotent: false,
  })
})

describe("POST /api/finance/receipts/scan", () => {
  it("401s when unauthenticated", async () => {
    h.auth.mockResolvedValueOnce(null)
    expect((await POST(req(jpeg()))).status).toBe(401)
    expect(h.scanReceipt).not.toHaveBeenCalled()
  })

  it("503s when receipt scanning is not configured", async () => {
    h.receiptScanConfigured.mockReturnValueOnce(false)
    expect((await POST(req(jpeg()))).status).toBe(503)
    expect(h.scanReceipt).not.toHaveBeenCalled()
  })

  it("400s when no file is provided", async () => {
    expect((await POST(req(undefined))).status).toBe(400)
  })

  it("400s on an unsupported media type (never calls the LLM path)", async () => {
    const heic = new File([new Uint8Array([1])], "r.heic", { type: "image/heic" })
    expect((await POST(req(heic))).status).toBe(400)
    expect(h.scanReceipt).not.toHaveBeenCalled()
  })

  it("scans a supported image into the household and revalidates", async () => {
    const res = await POST(req(jpeg()))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, store: "Costco Wholesale", itemCount: 1 })
    expect(h.scanReceipt).toHaveBeenCalledWith({ householdId: "h1" }, expect.any(Uint8Array), "image/jpeg")
    expect(h.revalidatePath).toHaveBeenCalledWith("/finance")
  })
})
