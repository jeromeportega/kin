import "server-only"
import { auth } from "@/auth"

export async function resolveScope(): Promise<string> {
  const session = await auth()
  if (!session?.user?.email) {
    throw new Error("Unauthenticated: no active session")
  }
  return session.user.email
}
