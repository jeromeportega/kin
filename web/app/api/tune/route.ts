import "server-only"
import { auth } from "@/auth"
import { applyTuning } from "@/lib/kinConfig"

// Apply tuning answers to kin.toml: add senders to the allow/blocklist and terms
// to the subject keywords. Authenticated (the config is shared, single-tenant for
// this POC). Returns how many NEW entries landed per list.
export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthenticated" }, { status: 401 })
  }

  let body: { allow?: unknown; block?: unknown; keyword?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const asStrings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

  try {
    const added = await applyTuning(
      {
        allow: asStrings(body.allow),
        block: asStrings(body.block),
        keyword: asStrings(body.keyword),
      },
      session.user.email
    )
    return Response.json({ ok: true, added }, { status: 200 })
  } catch {
    return Response.json({ error: "Failed to update config" }, { status: 500 })
  }
}
