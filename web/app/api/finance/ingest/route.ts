import "server-only"
import { randomUUID } from "node:crypto"
import { revalidatePath } from "next/cache"
import { eq } from "drizzle-orm"
import { auth } from "@/auth"
import { createDb, type FinanceDb } from "@/lib/finance/db/client"
import { accounts } from "@/lib/finance/db/schema"
import { resolveHouseholdScope, reconcileHousehold } from "@/lib/finance/server"
import { importSource } from "@/lib/finance/core/ingest/pipeline"
import { bankAdapter } from "@/lib/finance/core/adapters/bank/bank.adapter"
import { amazonAdapter } from "@/lib/finance/core/adapters/amazon/amazon.adapter"
import { emlAdapter } from "@/lib/finance/core/adapters/eml.adapter"
import { retailerApiAdapter } from "@/lib/finance/core/adapters/retailer-api.adapter"
import type { RawInput, SourceAdapter } from "@/lib/finance/core/adapters/source-adapter"

const adapters: SourceAdapter[] = [bankAdapter, amazonAdapter, retailerApiAdapter, emlAdapter]

/** Find-or-create a default account for the household (bank transactions need one). */
async function defaultAccountId(db: FinanceDb, householdId: string): Promise<string> {
  const existing = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.householdId, householdId))
    .limit(1)
  if (existing[0]) return existing[0].id
  const id = randomUUID()
  await db.insert(accounts).values({ id, householdId, name: "Primary", type: "checking" })
  return id
}

/** POST /api/finance/ingest — multipart { file, kind?: "bank"|"amazon" }. Lands a
 *  bank statement or Amazon order export into the signed-in user's household. */
export async function POST(request: Request): Promise<Response> {
  const session = await auth()
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthenticated" }, { status: 401 })
  }

  const form = await request.formData()
  const file = form.get("file")
  const kind = form.get("kind") === "amazon" ? "amazon" : "bank"
  if (!(file instanceof File)) {
    return Response.json({ error: "file is required" }, { status: 400 })
  }

  const scope = await resolveHouseholdScope(session.user.email)
  const db = createDb()

  const input: RawInput = {
    kind,
    filename: file.name || `${kind}-upload`,
    bytes: new Uint8Array(await file.arrayBuffer()),
  }
  const ctx =
    kind === "amazon"
      ? { householdId: scope.householdId }
      : { householdId: scope.householdId, accountId: await defaultAccountId(db, scope.householdId) }

  try {
    const result = await importSource(db, input, ctx, adapters)
    // Re-link the household now that new rows have landed: a bank import matches
    // against orders/receipts already present, and vice versa.
    await reconcileHousehold(scope)
    revalidatePath("/finance")
    return Response.json({ ok: true, ...result }, { status: 200 })
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
