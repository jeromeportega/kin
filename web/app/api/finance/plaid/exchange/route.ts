import "server-only"
import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import { resolveHouseholdScope } from "@/lib/finance/server"
import { exchangeAndSync } from "@/lib/finance/plaid/server"
import { plaidConfigured } from "@/lib/finance/plaid/client"

interface ExchangeBody {
  public_token?: string
  institution?: { id?: string; name?: string }
}

/** POST /api/finance/plaid/exchange — swap the Link public_token for a durable
 *  access token, store the Item, then pull an initial sync + reconcile. */
export async function POST(request: Request): Promise<Response> {
  const session = await auth()
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthenticated" }, { status: 401 })
  }
  if (!plaidConfigured()) {
    return Response.json({ error: "Plaid is not configured" }, { status: 503 })
  }
  const body = (await request.json().catch(() => null)) as ExchangeBody | null
  if (!body?.public_token) {
    return Response.json({ error: "public_token is required" }, { status: 400 })
  }
  const scope = await resolveHouseholdScope(session.user.email)
  try {
    const result = await exchangeAndSync(scope, body.public_token, body.institution)
    revalidatePath("/finance")
    return Response.json({ ok: true, ...result })
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
