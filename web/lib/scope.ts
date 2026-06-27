import "server-only"
import { auth } from "@/auth"

export async function resolveScope(): Promise<string> {
  const session = await auth()
  if (!session) {
    throw new Error("Unauthenticated: no active session")
  }
  const demoUser = process.env.KIN_DEMO_USER
  if (!demoUser) {
    throw new Error("KIN_DEMO_USER is not configured")
  }
  // POC: all authenticated users are mapped to a single demo scope — replace with session.user.id before production
  return demoUser
}
