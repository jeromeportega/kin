import { signIn } from "@/auth"
import { Button } from "@/components/ui/button"

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="flex flex-col items-center gap-6">
        <h1 className="text-2xl font-semibold">Sign in to kin</h1>
        <form
          action={async () => {
            "use server"
            await signIn("google", { redirectTo: "/dashboard" })
          }}
        >
          <Button type="submit">Sign in with Google</Button>
        </form>
      </div>
    </main>
  )
}
