import "server-only"
import { auth } from "@/auth"

export async function resolveScope(): Promise<string> {
  const session = await auth()
  if (!session) {
    throw new Error("Unauthenticated: no active session")
  }
  if (!session.user?.email) {
    throw new Error("Unauthenticated: session has no email")
  }
  return session.user.email
}
