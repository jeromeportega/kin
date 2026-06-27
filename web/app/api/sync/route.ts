import "server-only"
import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import { spawnIngestion, TIMEOUT_EXIT } from "@/lib/spawnIngestion"

// EXIT_REAUTH from ingest/run.py — a revoked/expired refresh token
const EXIT_REAUTH = 2

// Process-local dedup guard. In multi-instance deployments (Vercel, PM2 cluster,
// Docker replicas) each instance has its own Set, so this only prevents duplicate
// spawns within a single process — not across instances.
const inFlight = new Set<string>()

export async function POST() {
  const session = await auth()
  if (!session) {
    return Response.json({ error: "Unauthenticated: no active session" }, { status: 401 })
  }
  if (!session.user?.email) {
    return Response.json({ error: "Unauthenticated: session has no email" }, { status: 401 })
  }

  const email = session.user.email

  if (inFlight.has(email)) {
    return Response.json({ error: "Sync already in progress" }, { status: 429 })
  }

  inFlight.add(email)
  try {
    const exitCode = await spawnIngestion(email)

    if (exitCode === 0) {
      revalidatePath("/dashboard")
      return Response.json({ ok: true }, { status: 200 })
    }
    if (exitCode === EXIT_REAUTH) {
      return Response.json({ reauth: true }, { status: 409 })
    }
    if (exitCode === TIMEOUT_EXIT) {
      return Response.json({ error: "Sync timed out" }, { status: 504 })
    }
    return Response.json({ ok: false }, { status: 500 })
  } finally {
    inFlight.delete(email)
  }
}
