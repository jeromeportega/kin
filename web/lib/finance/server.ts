import "server-only"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { createDb, type FinanceDb } from "./db/client"
import { households } from "./db/schema"
import { gatewayFor } from "./core/reconciliation/gateway"
import { assembleQueue } from "./core/queue/assemble"
import type { HouseholdScope } from "./core/scope"
import type { QueueItem } from "./core/queue/types"

// The finance module's server entry points for kin's web layer: household scope
// tied to the kin user, and the review-queue read. Reads always hit the LIVE
// gateway (the real DB) — clarity's stub/demo backend is never used in kin.

let _db: FinanceDb | undefined
function db(): FinanceDb {
  return (_db ??= createDb())
}

/** Find-or-create the household owned by this kin user (session email). Replaces
 *  clarity's single hardcoded demo household. */
export async function resolveHouseholdScope(userId: string): Promise<HouseholdScope> {
  const existing = await db()
    .select({ id: households.id })
    .from(households)
    .where(eq(households.ownerUserId, userId))
    .limit(1)
  if (existing[0]) return { householdId: existing[0].id }

  const id = randomUUID()
  await db().insert(households).values({ id, name: userId, ownerUserId: userId })
  return { householdId: id }
}

export async function fetchQueue(scope: HouseholdScope): Promise<QueueItem[]> {
  const gw = gatewayFor({ RECON_BACKEND: "live" })
  return assembleQueue(scope, gw, db())
}
