import { auth } from "@/auth"
import { NextResponse } from "next/server"
import type { Session } from "next-auth"

export function guardDashboard(
  session: Session | null,
  origin: string
): Response | undefined {
  if (!session) {
    return NextResponse.redirect(new URL("/signin", origin))
  }
}

export default auth((req) => guardDashboard(req.auth, req.nextUrl.origin) as any)

export const config = {
  matcher: ["/dashboard/:path*"],
}
