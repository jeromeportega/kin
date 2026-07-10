import "server-only"
import { join } from "node:path"
import Anthropic from "@anthropic-ai/sdk"
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"

import { processReceipt, DEFAULT_RECEIPT_CONFIG } from "../core/receipts"
import { LiveAnthropicVisionProvider } from "../core/receipts/vision/live-anthropic-vision-provider"
import type { SupportedMimeType } from "../core/receipts/vision/vision-provider"
import { LibSqlReceiptStore } from "../core/receipts/store/libsql-receipt-store"
import { schema as receiptStoreSchema } from "../core/receipts/store/h1-schema"
import { LibSqlSkuDictionary } from "../core/receipts/dictionary/libsql-sku-dictionary"
import { schema as dictSchema } from "../core/receipts/dictionary/schema"
import { LlmSkuResolver, AnthropicSkuResolver } from "../core/receipts/resolver/llm-resolver"
import type { HouseholdScope } from "../core/scope"
import { reconcileHousehold } from "../server"

// Wires clarity's receipt-vision pipeline (built + eval-tested, previously
// unwired) to kin's web layer: upload → Claude vision extract → SKU resolve →
// arithmetic reconcile → persist to receipts/receipt_items, then a household
// reconcile so the receipt links to its bank transaction.

/** True when the Anthropic key is present — gates the scan UI + route (dormant
 *  without it, like Plaid without keys). */
export function receiptScanConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY)
}

/** kin's shared libSQL client — Turso in prod, the local SQLite file in dev.
 *  Mirrors createDb()'s resolution; the receipt store/dictionary need a
 *  schema-typed drizzle instance, which createDb() (schema-less) doesn't give. */
function sharedClient() {
  const tursoUrl = process.env.TURSO_DATABASE_URL
  if (tursoUrl) {
    return createClient({ url: tursoUrl, authToken: process.env.TURSO_AUTH_TOKEN })
  }
  const file = process.env.KIN_DB_PATH ?? join(process.cwd(), "..", "data", "kin.sqlite")
  return createClient({ url: `file:${file}` })
}

export interface ScanReceiptResult {
  store: string | null
  totalCents: number | null
  itemCount: number
  status: "ok" | "needs_review"
  idempotent: boolean
}

/**
 * Scan one receipt image/PDF into the signed-in user's household. Constructs the
 * injected deps (the core never builds an Anthropic client) and runs the
 * pipeline, then reconciles so the new receipt matches against bank data.
 */
export async function scanReceipt(
  scope: HouseholdScope,
  bytes: Uint8Array,
  mimeType: SupportedMimeType,
): Promise<ScanReceiptResult> {
  const client = new Anthropic() // reads ANTHROPIC_API_KEY
  const dbClient = sharedClient()
  const storeDb = drizzle(dbClient, { schema: receiptStoreSchema })
  const dictDb = drizzle(dbClient, { schema: dictSchema })

  const dictionary = new LibSqlSkuDictionary(dictDb)
  const result = await processReceipt(
    { bytes, mimeType },
    {
      vision: new LiveAnthropicVisionProvider({ client }),
      resolver: new LlmSkuResolver({
        dictionary,
        llm: new AnthropicSkuResolver({ client }),
        confidenceThreshold: DEFAULT_RECEIPT_CONFIG.confidenceThreshold,
      }),
      dictionary,
      store: new LibSqlReceiptStore(storeDb),
      householdId: scope.householdId,
      source: "photo",
    },
    DEFAULT_RECEIPT_CONFIG,
  )

  // A fresh receipt may match a bank transaction — re-link the household. A
  // re-uploaded (idempotent) receipt changed nothing, so skip the work.
  if (!result.idempotent) await reconcileHousehold(scope)

  return {
    store: result.receipt.store,
    totalCents: result.receipt.totalCents,
    itemCount: result.items.length,
    status: result.status,
    idempotent: result.idempotent,
  }
}
