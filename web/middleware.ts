import { auth } from "@/auth"
import { NextResponse } from "next/server"
import type { Session } from "next-auth"

const BASE_URL =
  process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? "http://localhost:3000"

export function guardDashboard(
  session: Session | null
): NextResponse | undefined {
  if (!session) {
    return NextResponse.redirect(new URL("/signin", BASE_URL))
  }
}

export default auth((req) => guardDashboard(req.auth))

export const config = {
  matcher: ["/dashboard/:path*"],
}
