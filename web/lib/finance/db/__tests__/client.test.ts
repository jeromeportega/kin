import { describe, it, expect, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { createTestFinanceDb } from "@/lib/finance/db/client"
import { households, transactions, receipts } from "@/lib/finance/db/schema"

describe("finance db foundation", () => {
  it("createTestFinanceDb applies the full finance schema (tables are queryable)", async () => {
    const { db, cleanup } = await createTestFinanceDb()
    try {
      // No "no such table" — the migrations created them.
      expect(await db.select().from(households)).toEqual([])
      expect(await db.select().from(transactions)).toEqual([])
      expect(await db.select().from(receipts)).toEqual([])
    } finally {
      cleanup()
    }
  })

  it("round-trips a row through drizzle", async () => {
    const { db, cleanup } = await createTestFinanceDb()
    try {
      await db.insert(households).values({ id: "h1", name: "Ortega Household" })
      const rows = await db.select().from(households)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.name).toBe("Ortega Household")
    } finally {
      cleanup()
    }
  })
})
