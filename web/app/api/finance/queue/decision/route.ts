import "server-only"
import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import { resolveHouseholdScope, recordQueueDecision } from "@/lib/finance/server"
import type { QueueItemType } from "@/lib/finance/core/queue/types"
import type { CorrectionAction } from "@/lib/finance/core/corrections/apply"
import { DEFAULT_CATEGORIES } from "@/lib/finance/db/schema"

const ITEM_TYPES = new Set<QueueItemType>([
  "sku_resolution",
  "ambiguous_match",
  "unmatched_txn",
  "flagged_receipt",
])
const CATEGORIES = new Set<string>(DEFAULT_CATEGORIES)

interface DecisionBody {
  itemId?: string
  itemType?: string
  action?: string
  /** For action=correct: the picked category (a DEFAULT_CATEGORIES name). */
  categoryId?: string
}

/** Map the request body to a CorrectionAction, or null if malformed.
 *  confirm/dismiss are payload-free; correct carries a pickCategoryId. */
function buildAction(body: DecisionBody): CorrectionAction | null {
  if (body.action === "confirm") return { type: "confirm" }
  if (body.action === "dismiss") return { type: "dismiss" }
  if (body.action === "correct") {
    if (!body.categoryId || !CATEGORIES.has(body.categoryId)) return null
    return { type: "correct", correction: { variant: "pickCategoryId", categoryId: body.categoryId } }
  }
  return null
}

/** POST /api/finance/queue/decision — record a confirm / dismiss / correct on a
 *  review-queue item, which drops it from the queue. */
export async function POST(request: Request): Promise<Response> {
  const session = await auth()
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthenticated" }, { status: 401 })
  }
  const body = (await request.json().catch(() => null)) as DecisionBody | null
  if (!body?.itemId || !body.itemType || !ITEM_TYPES.has(body.itemType as QueueItemType)) {
    return Response.json({ error: "itemId and a valid itemType are required" }, { status: 400 })
  }
  const action = buildAction(body)
  if (!action) {
    return Response.json(
      { error: "a valid action is required: confirm | dismiss | correct (+ a valid categoryId)" },
      { status: 400 },
    )
  }

  const scope = await resolveHouseholdScope(session.user.email)
  try {
    await recordQueueDecision(scope, body.itemId, body.itemType as QueueItemType, action)
    revalidatePath("/finance")
    return Response.json({ ok: true })
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
