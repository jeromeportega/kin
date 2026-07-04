import { redirect } from "next/navigation"
import { auth } from "@/auth"
import { resolveHouseholdScope, fetchQueue } from "@/lib/finance/server"
import { QueueView } from "@/components/finance/queue/QueueView"

export const dynamic = "force-dynamic"

export default async function FinancePage() {
  const session = await auth()
  if (!session?.user?.email) redirect("/signin")

  const scope = await resolveHouseholdScope(session.user.email)
  const items = await fetchQueue(scope)

  return (
    <main className="container mx-auto max-w-4xl py-8 px-4">
      <div className="mb-4">
        <h1 className="text-xl font-semibold">Finance — Review Queue</h1>
        <p className="text-sm text-muted-foreground">
          Items that need a look before every dollar is counted once. Import bank and
          Amazon exports, and anything the reconcile loop is unsure of lands here.
        </p>
      </div>
      <QueueView items={items} />
    </main>
  )
}
