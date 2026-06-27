import NextAuth from "next-auth"
import Google from "next-auth/providers/google"
import { NextResponse } from "next/server"
import type { Session } from "next-auth"
import { GOOGLE_SCOPE, SESSION_STRATEGY } from "@/auth.config"

// Edge-safe auth instance for the middleware ONLY. It must NOT import "@/auth",
// which transitively pulls in lib/tokenStore (Node fs/path) and crashes the Edge
// Runtime. The middleware only needs to DECODE the session (provider config is
// enough); the Node-only jwt/tokenStore callback lives in "@/auth" for the server.
const { auth } = NextAuth({
  secret: process.env.AUTH_SECRET,
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: { scope: GOOGLE_SCOPE, access_type: "offline", prompt: "consent" },
      },
    }),
  ],
  session: { strategy: SESSION_STRATEGY },
  pages: { signIn: "/signin" },
})

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
