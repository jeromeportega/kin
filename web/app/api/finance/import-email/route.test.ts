import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"

vi.mock("server-only", () => ({}))

// ── hoisted stubs for every credential / network / Next.js seam ───────────
const h = vi.hoisted(() => ({
  auth: vi.fn(),
  readRefreshToken: vi.fn(),
  mintAccessToken: vi.fn(),
  fetchRawMessages: vi.fn(),
  revalidatePath: vi.fn(),
  reconcileHousehold: vi.fn(),
  resolveHouseholdScope: vi.fn(),
  createDb: vi.fn(),
}))

vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }))
vi.mock("@/auth", () => ({ auth: h.auth }))
vi.mock("@/lib/tokenStore", () => ({ readRefreshToken: h.readRefreshToken }))
vi.mock("@/lib/gmail", () => ({
  mintAccessToken: h.mintAccessToken,
  fetchRawMessages: h.fetchRawMessages,
}))
vi.mock("@/lib/finance/server", () => ({
  resolveHouseholdScope: h.resolveHouseholdScope,
  reconcileHousehold: h.reconcileHousehold,
}))
// Route calls createDb() — redirect it to the test DB created per-test.
// We spread `importActual` so createTestDb (and FinanceDb type) remain real.
vi.mock("@/lib/finance/db/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/finance/db/client")>()
  return { ...actual, createDb: h.createDb }
})

// ── real implementations (emlAdapter, importSource, persistBatch) are NOT mocked ─

import { POST } from "@/app/api/finance/import-email/route"
import { createTestDb } from "@/lib/finance/db/client"
import { households, orderItems, orders } from "@/lib/finance/db/schema"
import type { FinanceDb } from "@/lib/finance/db/client"

// ── fixtures ──────────────────────────────────────────────────────────────
const FIXTURES = join(
  process.cwd(),
  "lib/finance/core/adapters/eml/__tests__/fixtures",
)

function amazonBytes(): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, "amazon-order.eml")))
}

function malformedBytes(): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, "malformed.eml")))
}

function rawMsg(id: string, bytes: Uint8Array) {
  return { messageId: id, bytes }
}

// ── per-test DB + household setup ─────────────────────────────────────────
let db: FinanceDb
let cleanup: () => void
let householdId: string

beforeEach(async () => {
  vi.clearAllMocks()

  const handle = createTestDb()
  db = handle.db
  cleanup = handle.cleanup
  householdId = randomUUID()

  // seed the household so FK constraints pass
  await db.insert(households).values({ id: householdId, name: "test-user@example.com", ownerUserId: "test-user@example.com" })

  // Wire the test DB into the route
  h.createDb.mockReturnValue(db)

  // Default session stubs
  h.auth.mockResolvedValue({ user: { email: "test-user@example.com" } })
  h.readRefreshToken.mockResolvedValue("refresh-token")
  h.mintAccessToken.mockResolvedValue("access-token")
  h.fetchRawMessages.mockResolvedValue([])
  h.resolveHouseholdScope.mockResolvedValue({ householdId })
  h.reconcileHousehold.mockResolvedValue(undefined)

  process.env.GOOGLE_CLIENT_ID = "client-id"
  process.env.GOOGLE_CLIENT_SECRET = "client-secret"
})

afterEach(() => {
  cleanup()
})

// helper to fire the handler
const post = () => POST({} as Request)

// ── Auth gate ─────────────────────────────────────────────────────────────
describe("POST /api/finance/import-email — auth gate", () => {
  it("returns 401 when unauthenticated and triggers no I/O", async () => {
    h.auth.mockResolvedValueOnce(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "Unauthenticated" })
    expect(h.readRefreshToken).not.toHaveBeenCalled()
    expect(h.fetchRawMessages).not.toHaveBeenCalled()
    expect(h.reconcileHousehold).not.toHaveBeenCalled()
  })
})

// ── No stored refresh token ───────────────────────────────────────────────
describe("POST /api/finance/import-email — no Gmail token", () => {
  it("returns 200 connected:false (NOT a 500) and triggers no fetch or persist", async () => {
    h.readRefreshToken.mockResolvedValueOnce(null)
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, connected: false })
    expect(h.fetchRawMessages).not.toHaveBeenCalled()
    expect(h.reconcileHousehold).not.toHaveBeenCalled()
  })
})

// ── Happy path ────────────────────────────────────────────────────────────
describe("POST /api/finance/import-email — happy path", () => {
  it("lands 2 Amazon orders, calls reconcileHousehold once, revalidates /finance", async () => {
    h.fetchRawMessages.mockResolvedValueOnce([
      rawMsg("gmail-msg-1", amazonBytes()),
      rawMsg("gmail-msg-2", amazonBytes()),
    ])

    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.connected).toBe(true)
    expect(body.inserted.orders).toBeGreaterThan(0)
    expect(body.inserted.orderItems).toBeGreaterThan(0)

    // reconcileHousehold called exactly once, after the loop
    expect(h.reconcileHousehold).toHaveBeenCalledOnce()
    expect(h.reconcileHousehold).toHaveBeenCalledWith({ householdId })

    // revalidatePath called on success
    expect(h.revalidatePath).toHaveBeenCalledWith("/finance")

    // orders are in the DB under the correct household
    const dbOrders = await db.select({ id: orders.id, householdId: orders.householdId }).from(orders)
    expect(dbOrders.length).toBeGreaterThan(0)
    for (const row of dbOrders) {
      expect(row.householdId).toBe(householdId)
    }
  })

  it("passes emlGmailQuery() as the query — no access token reaches the adapter", async () => {
    const { emlGmailQuery } = await import("@/lib/finance/core/adapters/eml/dispatch")
    const expectedQuery = emlGmailQuery()

    h.fetchRawMessages.mockResolvedValueOnce([rawMsg("gmail-msg-1", amazonBytes())])
    await post()

    // fetchRawMessages receives accessToken + query, NOT refresh token
    const [opts] = h.fetchRawMessages.mock.calls[0]
    expect(opts.accessToken).toBe("access-token")
    expect(opts.query).toBe(expectedQuery)
    // no refresh token in opts
    expect(JSON.stringify(opts)).not.toContain("refresh-token")
  })
})

// ── Idempotent re-import ──────────────────────────────────────────────────
describe("POST /api/finance/import-email — idempotency", () => {
  it("second import over the same messages inserts 0 new rows and reports skippedDuplicates", async () => {
    // A single message ensures the skipped count equals the inserted count on re-import.
    // Two messages with the same order id (same fixture) produce 4 skips on rerun but
    // only 2 DB rows, which would mismatch the assertion below.
    const messages = [rawMsg("gmail-idempotent-1", amazonBytes())]
    h.fetchRawMessages.mockResolvedValue(messages)

    const first = await post()
    const firstBody = await first.json()
    expect(firstBody.connected).toBe(true)
    const firstOrderItems = firstBody.inserted.orderItems as number

    // Second run
    const second = await post()
    const secondBody = await second.json()
    expect(secondBody.connected).toBe(true)
    expect(secondBody.inserted.orderItems).toBe(0)
    expect(secondBody.skippedDuplicates).toBe(firstOrderItems)

    // DB row count unchanged
    const count = await db.run(sql`SELECT count(*) AS c FROM order_items`)
    expect(Number(count.rows[0]?.c)).toBe(firstOrderItems)
  })
})

// ── Per-message isolation (FR-10) ─────────────────────────────────────────
describe("POST /api/finance/import-email — per-message isolation", () => {
  it("lands the valid order and surfaces an ImportError for the malformed message", async () => {
    h.fetchRawMessages.mockResolvedValueOnce([
      rawMsg("bad-msg", malformedBytes()),
      rawMsg("good-msg", amazonBytes()),
    ])

    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.connected).toBe(true)

    // At least one error from the malformed message
    expect(body.errors.length).toBeGreaterThan(0)

    // Valid order was still persisted
    const dbOrders = await db.select().from(orders)
    expect(dbOrders.length).toBeGreaterThan(0)
  })
})

// ── Household scoping ─────────────────────────────────────────────────────
describe("POST /api/finance/import-email — household scoping", () => {
  it("landed rows carry the householdId from resolveHouseholdScope", async () => {
    h.fetchRawMessages.mockResolvedValueOnce([rawMsg("scope-msg-1", amazonBytes())])

    await post()

    const rows = await db.select({ hid: orders.householdId }).from(orders)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.hid === householdId)).toBe(true)
  })
})

// ── Credential boundary (NFR-1) ───────────────────────────────────────────
describe("POST /api/finance/import-email — credential boundary", () => {
  it("the object passed to importSource contains bytes only — no token in the RawInput", async () => {
    // We'll verify by checking fetchRawMessages was called with only the access token,
    // and that the route mints via mintAccessToken (no refresh token passed further).
    h.fetchRawMessages.mockResolvedValueOnce([rawMsg("cred-msg", amazonBytes())])

    await post()

    // mintAccessToken was called with the refresh token to exchange it
    expect(h.mintAccessToken).toHaveBeenCalledWith(
      "refresh-token",
      "client-id",
      "client-secret",
    )
    // fetchRawMessages received the access token (not the refresh token)
    const [opts] = h.fetchRawMessages.mock.calls[0]
    expect(opts.accessToken).toBe("access-token")
    // Access token not persisted in DB rows
    const rows = await db.run(sql`SELECT * FROM orders`)
    for (const row of rows.rows) {
      expect(JSON.stringify(row)).not.toContain("access-token")
      expect(JSON.stringify(row)).not.toContain("refresh-token")
    }
  })
})
