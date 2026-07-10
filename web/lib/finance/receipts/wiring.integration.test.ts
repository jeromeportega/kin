import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { eq } from "drizzle-orm"

import { createTestDb, type FinanceDb } from "../db/client"
import { households, receipts, receiptItems } from "../db/schema"
import { LibSqlReceiptStore } from "../core/receipts/store/libsql-receipt-store"
import { schema as storeSchema } from "../core/receipts/store/h1-schema"
import { LibSqlSkuDictionary } from "../core/receipts/dictionary/libsql-sku-dictionary"
import { schema as dictSchema } from "../core/receipts/dictionary/schema"

// Proves the receipt-vision pipeline's DB seams (clarity's LibSqlReceiptStore /
// LibSqlSkuDictionary, which use their OWN drizzle table defs) actually read and
// write KIN's migrated receipts / receipt_items / sku_dictionary tables — the one
// real integration risk in wiring the pipeline to the web layer.

const HH = "hh-receipt-wire-1"

let handle: { db: FinanceDb; cleanup: () => void; file: string }
let storeDb: ReturnType<typeof drizzle<typeof storeSchema>>
let dictDb: ReturnType<typeof drizzle<typeof dictSchema>>

beforeEach(async () => {
  handle = createTestDb()
  const client = createClient({ url: `file:${handle.file}` })
  storeDb = drizzle(client, { schema: storeSchema })
  dictDb = drizzle(client, { schema: dictSchema })
  await handle.db.insert(households).values({ id: HH, name: "test" })
})

afterEach(() => handle.cleanup())

describe("receipt store/dictionary ↔ kin's migrated schema", () => {
  it("LibSqlReceiptStore inserts a receipt + items that read back through kin's own schema", async () => {
    const store = new LibSqlReceiptStore(storeDb)

    // Shaped like the real Costco extraction.
    const receipt = await store.insertReceipt({
      householdId: HH,
      source: "photo",
      store: "Costco Wholesale",
      purchasedAt: "2026-05-16",
      subtotalCents: 8999,
      taxCents: 787,
      totalCents: 9786,
      paymentLast4: "7061",
      imageHash: "sha-costco-1",
      needsReview: false,
    })
    expect(receipt.id).toBeTruthy()

    const items = await store.insertReceiptItems([
      {
        receiptId: receipt.id,
        lineNo: 1,
        sku: "1819487",
        rawDescription: "TETRIS",
        canonicalName: "Tetris",
        categoryId: null,
        quantity: 1,
        unitPriceCents: 8999,
        linePriceCents: 8999,
        discountCents: 0,
        nameConfidence: 1,
        categoryConfidence: 0,
        refundDestination: null,
        needsReview: false,
      },
    ])
    expect(items).toHaveLength(1)

    // Read back through KIN's finance drizzle schema — proves the tables match.
    const [r] = await handle.db.select().from(receipts).where(eq(receipts.householdId, HH))
    expect(r!.store).toBe("Costco Wholesale")
    expect(r!.totalCents).toBe(9786)
    expect(r!.paymentLast4).toBe("7061")

    const [ri] = await handle.db.select().from(receiptItems).where(eq(receiptItems.receiptId, receipt.id))
    expect(ri!.rawDescription).toBe("TETRIS")
    expect(ri!.linePriceCents).toBe(8999)
    expect(ri!.sku).toBe("1819487")

    // Idempotency seam the pipeline relies on.
    expect(await store.findReceiptByImageHash("sha-costco-1")).not.toBeNull()
    expect(await store.findReceiptByImageHash("nope")).toBeNull()
  })

  it("LibSqlSkuDictionary upsert + lookup round-trips against kin's sku_dictionary", async () => {
    const dict = new LibSqlSkuDictionary(dictDb)
    await dict.upsert({
      store: "costco",
      skuOrAbbrev: "tetris",
      canonicalName: "Tetris Board Game",
      category: "other",
      nameConfidence: 1,
      categoryConfidence: 1,
      source: "human",
      updatedAt: 1,
    })
    const hit = await dict.lookup("costco", "tetris")
    expect(hit?.canonicalName).toBe("Tetris Board Game")
  })
})
