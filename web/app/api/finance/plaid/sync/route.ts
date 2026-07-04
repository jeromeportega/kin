import "server-only"
import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import { resolveHouseholdScope } from "@/lib/finance/server"
import { syncHousehold } from "@/lib/finance/plaid/server"
import { plaidConfigured } from "@/lib/finance/plaid/client"

/** POST /api/finance/plaid/sync — pull the latest transactions for every linked
 *  Item in the household and re-reconcile. On-demand refresh (button / page). */
export async function POST(): Promise<Response> {
  const session = await auth()
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthenticated" }, { status: 401 })
  }
  if (!plaidConfigured()) {
    return Response.json({ error: "Plaid is not configured" }, { status: 503 })
  }
  const scope = await resolveHouseholdScope(session.user.email)
  try {
    const result = await syncHousehold(scope)
    revalidatePath("/finance")
    return Response.json({ ok: true, ...result })
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
