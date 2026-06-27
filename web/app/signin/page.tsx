import { signIn } from "@/auth"
import { Button } from "@/components/ui/button"
import { AuthError } from "next-auth"
import { redirect } from "next/navigation"

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="flex flex-col items-center gap-6">
        <h1 className="text-2xl font-semibold">Sign in to kin</h1>
        <form
          action={async () => {
            "use server"
            try {
              await signIn("google", { redirectTo: "/dashboard" })
            } catch (e) {
              if (e instanceof AuthError) {
                redirect("/signin?error=OAuthError")
              }
              throw e
            }
          }}
        >
          <Button type="submit">Sign in with Google</Button>
        </form>
      </div>
    </main>
  )
}
