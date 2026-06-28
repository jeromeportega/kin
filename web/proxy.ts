import NextAuth from "next-auth"
import Google from "next-auth/providers/google"
import { NextResponse } from "next/server"
import type { Session } from "next-auth"
import { GOOGLE_SCOPE, SESSION_STRATEGY } from "@/auth.config"

// Edge-safe auth instance for the proxy ONLY. It must NOT import "@/auth", which
// transitively pulls in lib/tokenStore -> lib/db (server-only) and crashes the
// Edge Runtime. The proxy only needs to DECODE the session (provider config is
// enough); the server-only jwt/tokenStore callback lives in "@/auth".
const { auth } = NextAuth({
  trustHost: true,
  secret: process.env.AUTH_SECRET,
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID ?? process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? process.env.AUTH_GOOGLE_SECRET,
      authorization: {
        params: { scope: GOOGLE_SCOPE, access_type: "offline", prompt: "consent" },
      },
    }),
  ],
  session: { strategy: SESSION_STRATEGY },
  pages: { signIn: "/signin" },
})

// Redirect relative to the request's own origin so it works on any domain
// (production, preview, localhost) without a hardcoded base URL.
export function guardDashboard(
  session: Session | null,
  origin: string
): NextResponse | undefined {
  if (!session) {
    return NextResponse.redirect(new URL("/signin", origin))
  }
}

export default auth((req) => guardDashboard(req.auth, req.nextUrl.origin))

export const config = {
  matcher: ["/dashboard/:path*"],
}
