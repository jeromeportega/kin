import "server-only"
import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import { resolveHouseholdScope, recordQueueDecision } from "@/lib/finance/server"
import type { QueueItemType } from "@/lib/finance/core/queue/types"

const ITEM_TYPES = new Set<QueueItemType>([
  "sku_resolution",
  "ambiguous_match",
  "unmatched_txn",
  "flagged_receipt",
])
// confirm / dismiss are the no-payload decisions. 'correct' needs a per-variant
// correction payload + UI and is a documented follow-up.
const ACTIONS = new Set(["confirm", "dismiss"])

interface DecisionBody {
  itemId?: string
  itemType?: string
  action?: string
}

/** POST /api/finance/queue/decision — record a confirm/dismiss on a review-queue
 *  item, which drops it from the queue. */
export async function POST(request: Request): Promise<Response> {
  const session = await auth()
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthenticated" }, { status: 401 })
  }
  const body = (await request.json().catch(() => null)) as DecisionBody | null
  if (
    !body?.itemId ||
    !body.itemType ||
    !ITEM_TYPES.has(body.itemType as QueueItemType) ||
    !body.action ||
    !ACTIONS.has(body.action)
  ) {
    return Response.json(
      { error: "itemId, itemType and a valid action (confirm|dismiss) are required" },
      { status: 400 },
    )
  }

  const scope = await resolveHouseholdScope(session.user.email)
  try {
    await recordQueueDecision(scope, body.itemId, body.itemType as QueueItemType, {
      type: body.action as "confirm" | "dismiss",
    })
    revalidatePath("/finance")
    return Response.json({ ok: true })
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
