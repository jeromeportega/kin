import NextAuth from "next-auth"
import Google from "next-auth/providers/google"
import { GOOGLE_SCOPE, SESSION_STRATEGY } from "@/auth.config"
// NOTE: tokenStore uses Node's fs/path. It is imported LAZILY inside the jwt
// callback (which only runs server-side) so it never enters the static module
// graph that the Edge Middleware bundles — a static import makes the edge runtime
// throw "Node.js module not supported in the Edge Runtime" and every route 500s.

// Accept either env-var name (GOOGLE_CLIENT_ID or Auth.js's AUTH_GOOGLE_ID) so
// the deploy works with either convention — matching lib/ingest.ts.
const secret = process.env.AUTH_SECRET
const clientId = process.env.GOOGLE_CLIENT_ID ?? process.env.AUTH_GOOGLE_ID
const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? process.env.AUTH_GOOGLE_SECRET

// Validate at runtime only. During `next build` page-data collection the env
// vars may be absent, and a module-load throw there fails the build (it did).
if (process.env.NEXT_PHASE !== "phase-production-build") {
  if (!secret) throw new Error("AUTH_SECRET is required")
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID or AUTH_GOOGLE_ID is required")
  if (!clientSecret) throw new Error("GOOGLE_CLIENT_SECRET or AUTH_GOOGLE_SECRET is required")
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Trust the deployment host so next-auth derives its URL + OAuth callback from
  // the request (e.g. https://kin-one-alpha.vercel.app/api/auth/callback/google)
  // instead of a hardcoded AUTH_URL. Auto-enabled on Vercel; explicit for clarity.
  trustHost: true,
  secret,
  providers: [
    Google({
      clientId,
      clientSecret,
      authorization: {
        params: { scope: GOOGLE_SCOPE, access_type: "offline", prompt: "consent" },
      },
    }),
  ],
  session: { strategy: SESSION_STRATEGY },
  pages: { signIn: "/signin" },
  callbacks: {
    async jwt({ token, account }) {
      if (account?.refresh_token && token.email) {
        try {
          const { writeRefreshToken } = await import("@/lib/tokenStore")
          await writeRefreshToken(token.email, account.refresh_token)
        } catch (err) {
          console.error("tokenStore write failed:", (err as Error).message)
        }
      }
      return token
    },
    async session({ session }) {
      return session
    },
  },
})
