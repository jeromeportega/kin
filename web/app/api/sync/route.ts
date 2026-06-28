import "server-only"
import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import { runIngest } from "@/lib/ingest"
import { ReauthRequired } from "@/lib/gmail"

// Process-local dedup guard. In multi-instance deployments each instance has its
// own Set, so this only prevents duplicate syncs within a single process.
const inFlight = new Set<string>()

export async function POST() {
  const session = await auth()
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthenticated" }, { status: 401 })
  }
  const email = session.user.email

  if (inFlight.has(email)) {
    return Response.json({ error: "Sync already in progress" }, { status: 429 })
  }

  inFlight.add(email)
  try {
    const result = await runIngest(email)
    revalidatePath("/dashboard")
    return Response.json({ ok: true, ...result }, { status: 200 })
  } catch (err) {
    if (err instanceof ReauthRequired) {
      return Response.json({ reauth: true }, { status: 409 })
    }
    return Response.json({ ok: false, error: String(err) }, { status: 500 })
  } finally {
    inFlight.delete(email)
  }
}
