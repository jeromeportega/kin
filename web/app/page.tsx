import Link from "next/link"
import { redirect } from "next/navigation"
import { Mail, Wallet, ArrowRight } from "lucide-react"
import { auth } from "@/auth"
import { SignOutButton } from "@/components/SignOutButton"

export const dynamic = "force-dynamic"

// The module launcher. Each entry becomes a large card linking into a module;
// add a module here and it shows up on the home screen.
const MODULES = [
  {
    href: "/dashboard",
    title: "Email Triage",
    description: "Your inbox, classified and digested — priorities surfaced, noise muted.",
    Icon: Mail,
  },
  {
    href: "/finance",
    title: "Finance",
    description: "Bank, Amazon and receipts reconciled to the item, so every dollar is counted once.",
    Icon: Wallet,
  },
]

export default async function Home() {
  const session = await auth()
  if (!session?.user?.email) redirect("/signin")
  const name = session.user.name?.split(" ")[0] ?? null

  return (
    <main className="container mx-auto max-w-4xl px-4 py-12">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">kin</h1>
          <p className="mt-1 text-muted-foreground">
            {name ? `Welcome back, ${name}. ` : "Welcome back. "}Pick a module to jump in.
          </p>
        </div>
        <SignOutButton />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {MODULES.map(({ href, title, description, Icon }) => (
          <Link
            key={href}
            href={href}
            className="group flex flex-col gap-4 rounded-xl border bg-card p-6 text-card-foreground transition-colors hover:border-foreground/30 hover:bg-accent"
          >
            <div className="flex items-center justify-between">
              <span className="flex h-11 w-11 items-center justify-center rounded-lg border bg-background">
                <Icon className="h-5 w-5" aria-hidden />
              </span>
              <ArrowRight
                className="h-5 w-5 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </div>
            <div>
              <h2 className="text-lg font-semibold">{title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            </div>
          </Link>
        ))}
      </div>
    </main>
  )
}
