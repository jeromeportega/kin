import "server-only"
import { auth } from "@/auth"
import { resolveHouseholdScope } from "@/lib/finance/server"
import { createLinkToken } from "@/lib/finance/plaid/server"
import { plaidConfigured } from "@/lib/finance/plaid/client"

/** POST /api/finance/plaid/link-token — mint a Plaid Link token for the signed-in
 *  user's household. The client opens Plaid Link with it. */
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
    const linkToken = await createLinkToken(scope)
    return Response.json({ link_token: linkToken })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
