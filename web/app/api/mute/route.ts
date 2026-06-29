import "server-only"
import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import { muteSender, unmuteSender } from "@/lib/kinConfig"

// Mute (blocklist) or unmute a sender for the signed-in user. The dashboard's
// per-email "Mute sender" action and the muted-senders recovery list both POST here.
export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthenticated" }, { status: 401 })
  }

  let body: { sender?: unknown; unmute?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const sender = typeof body.sender === "string" ? body.sender.trim() : ""
  if (!sender) {
    return Response.json({ error: "sender is required" }, { status: 400 })
  }

  try {
    if (body.unmute === true) {
      await unmuteSender(session.user.email, sender)
    } else {
      await muteSender(session.user.email, sender)
    }
    revalidatePath("/dashboard")
    return Response.json({ ok: true, muted: body.unmute !== true }, { status: 200 })
  } catch {
    return Response.json({ error: "Failed to update mute list" }, { status: 500 })
  }
}
