import NextAuth from "next-auth"
import Google from "next-auth/providers/google"
import { GOOGLE_SCOPE, SESSION_STRATEGY } from "@/auth.config"
// NOTE: tokenStore uses Node's fs/path. It is imported LAZILY inside the jwt
// callback (which only runs server-side) so it never enters the static module
// graph that the Edge Middleware bundles — a static import makes the edge runtime
// throw "Node.js module not supported in the Edge Runtime" and every route 500s.

const secret = process.env.AUTH_SECRET
const clientId = process.env.GOOGLE_CLIENT_ID
const clientSecret = process.env.GOOGLE_CLIENT_SECRET

if (!secret) throw new Error("AUTH_SECRET is required")
if (!clientId) throw new Error("GOOGLE_CLIENT_ID is required")
if (!clientSecret) throw new Error("GOOGLE_CLIENT_SECRET is required")

export const { handlers, auth, signIn, signOut } = NextAuth({
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
