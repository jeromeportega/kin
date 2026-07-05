import "server-only"
import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import { createDb } from "@/lib/finance/db/client"
import { resolveHouseholdScope, reconcileHousehold } from "@/lib/finance/server"
import { importSource } from "@/lib/finance/core/ingest/pipeline"
import { bankAdapter } from "@/lib/finance/core/adapters/bank/bank.adapter"
import { amazonAdapter } from "@/lib/finance/core/adapters/amazon/amazon.adapter"
import { emlAdapter } from "@/lib/finance/core/adapters/eml.adapter"
import { retailerApiAdapter } from "@/lib/finance/core/adapters/retailer-api.adapter"
import { emlGmailQuery } from "@/lib/finance/core/adapters/eml/dispatch"
import { readRefreshToken } from "@/lib/tokenStore"
import { mintAccessToken, fetchRawMessages, ReauthRequired } from "@/lib/gmail"
import type { SourceAdapter, ImportError } from "@/lib/finance/core/adapters/source-adapter"

const IMPORT_LIMIT = 50

const adapters: SourceAdapter[] = [bankAdapter, amazonAdapter, retailerApiAdapter, emlAdapter]

/** POST /api/finance/import-email — no request body. Reads stored Gmail refresh
 *  token for the signed-in user, fetches Amazon order emails, and lands each
 *  one through the eml adapter → persistBatch → reconcileHousehold path. */
export async function POST(_request: Request): Promise<Response> {
  const session = await auth()
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthenticated" }, { status: 401 })
  }
  const email = session.user.email

  const refreshToken = await readRefreshToken(email)
  if (!refreshToken) {
    return Response.json({ ok: true, connected: false }, { status: 200 })
  }

  const clientId = process.env.GOOGLE_CLIENT_ID ?? process.env.AUTH_GOOGLE_ID ?? ""
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? process.env.AUTH_GOOGLE_SECRET ?? ""

  try {
    const accessToken = await mintAccessToken(refreshToken, clientId, clientSecret)

    const messages = await fetchRawMessages({
      accessToken,
      query: emlGmailQuery(),
      limit: IMPORT_LIMIT,
    })

    const scope = await resolveHouseholdScope(email)
    const db = createDb()

    const inserted = { transactions: 0, orders: 0, orderItems: 0, storeCreditRows: 0 }
    let skippedDuplicates = 0
    const errors: ImportError[] = []

    for (const msg of messages) {
      const result = await importSource(
        db,
        { kind: "eml", filename: msg.messageId, bytes: msg.bytes },
        { householdId: scope.householdId },
        adapters,
      )
      inserted.transactions += result.inserted.transactions
      inserted.orders += result.inserted.orders
      inserted.orderItems += result.inserted.orderItems
      inserted.storeCreditRows += result.inserted.storeCreditRows
      skippedDuplicates += result.skippedDuplicates
      errors.push(...result.errors)
    }

    await reconcileHousehold(scope)
    revalidatePath("/finance")

    return Response.json({ ok: true, connected: true, inserted, skippedDuplicates, errors }, { status: 200 })
  } catch (err) {
    // A revoked / expired refresh token surfaces as ReauthRequired — steer the
    // user to reconnect Gmail rather than showing a generic 500.
    if (err instanceof ReauthRequired) {
      return Response.json({ ok: true, connected: false }, { status: 200 })
    }
    return Response.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
