import { resolveScope } from "@/lib/scope"
import { fetchDigest } from "@/lib/api"
import { DigestView } from "@/components/digest/DigestView"
import { EmptyState } from "@/components/digest/EmptyState"

export default async function DashboardPage() {
  const userId = await resolveScope()
  const digest = await fetchDigest(userId)

  return (
    <main className="container mx-auto max-w-4xl py-8 px-4">
      {digest ? <DigestView digest={digest} /> : <EmptyState />}
    </main>
  )
}
