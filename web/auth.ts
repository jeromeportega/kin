import NextAuth from "next-auth"
import Google from "next-auth/providers/google"
import { GOOGLE_SCOPE, SESSION_STRATEGY } from "@/auth.config"

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: { params: { scope: GOOGLE_SCOPE } },
    }),
  ],
  session: { strategy: SESSION_STRATEGY },
})
