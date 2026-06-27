import { redirect } from "next/navigation"
import { resolveScope } from "@/lib/scope"
import { fetchDigest } from "@/lib/api"
import { DigestView } from "@/components/digest/DigestView"
import { EmptyState } from "@/components/digest/EmptyState"
import { SyncGmailButton } from "@/components/SyncGmailButton"

export default async function DashboardPage() {
  const userId = await resolveScope().catch(() => {
    redirect("/signin")
  })

  const digest = await fetchDigest(userId)

  return (
    <main className="container mx-auto max-w-4xl py-8 px-4">
      <div className="mb-4 flex justify-end">
        <SyncGmailButton />
      </div>
      {digest ? <DigestView digest={digest} /> : <EmptyState />}
    </main>
  )
}
