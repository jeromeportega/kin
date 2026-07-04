import "server-only"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { createDb, type FinanceDb } from "./db/client"
import { households } from "./db/schema"
import { gatewayFor } from "./core/reconciliation/gateway"
import { assembleQueue } from "./core/queue/assemble"
import { reconcile } from "./core/reconcile/engine"
import { DrizzleReconcileSource } from "./core/reconcile/source"
import { DrizzleReconcileSink } from "./core/reconcile/sink"
import { applyCorrection, type CorrectionAction } from "./core/corrections/apply"
import type { HouseholdScope } from "./core/scope"
import type { QueueItem, QueueItemType } from "./core/queue/types"

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

/** Reconcile the household's current corpus (bank ↔ orders ↔ receipts) and persist
 *  the resulting matches. Run after each ingest so newly-arrived data re-links
 *  against everything already imported. Idempotent: deterministic engine match
 *  ids + the sink's onConflictDoNothing make re-runs no-ops for existing links. */
export async function reconcileHousehold(scope: HouseholdScope): Promise<void> {
  const inputs = await new DrizzleReconcileSource(db()).load(scope.householdId)
  const ledger = reconcile(inputs)
  await new DrizzleReconcileSink(db()).persist(scope.householdId, ledger)
}

/** Record a review-queue decision (confirm / dismiss / correct). Writes the
 *  terminal review_decisions row via applyCorrection, which removes the item from
 *  the queue on the next read (assembleQueue anti-joins decided items). */
export async function recordQueueDecision(
  scope: HouseholdScope,
  itemId: string,
  itemType: QueueItemType,
  action: CorrectionAction,
): Promise<void> {
  const gw = gatewayFor({ RECON_BACKEND: "live" })
  // applyCorrection only reads item.id + item.type; reason is unused here.
  const item: QueueItem = { id: itemId, type: itemType, reason: "" }
  await applyCorrection(scope, item, action, gw, db())
}
