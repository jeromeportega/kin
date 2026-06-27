import { redirect } from "next/navigation"
import { resolveScope } from "@/lib/scope"
import { fetchDigest, fetchClassifications } from "@/lib/api"
import { readKinConfig } from "@/lib/kinConfig"
import { unfamiliarSenders, suggestKeywords } from "@/lib/tuning"
import { DashboardTabs } from "@/components/DashboardTabs"
import { TuningPrompt } from "@/components/TuningPrompt"
import { SyncGmailButton } from "@/components/SyncGmailButton"
import { SignOutButton } from "@/components/SignOutButton"

// The priority tabs show every classification, not just the curated digest, so
// use a wide window — a quiet inbox is sparse over 24h.
const WINDOW_HOURS = 720 // 30 days

export default async function DashboardPage() {
  const userId = await resolveScope().catch(() => {
    redirect("/signin")
  })

  const [digest, classifications, config] = await Promise.all([
    fetchDigest(userId),
    fetchClassifications(userId, WINDOW_HOURS),
    readKinConfig(),
  ])

  // Data-derived tuning cadence: surface senders the config doesn't cover yet.
  // When the user has okayed/muted everything arriving, this is empty and the
  // prompt hides itself.
  const unfamiliar = unfamiliarSenders(classifications, config)
  const suggestedKeywords = suggestKeywords(classifications, config)

  return (
    <main className="container mx-auto max-w-4xl py-8 px-4">
      <div className="mb-4 flex justify-end gap-2">
        <SyncGmailButton />
        <SignOutButton />
      </div>
      <TuningPrompt senders={unfamiliar} suggestedKeywords={suggestedKeywords} />
      <DashboardTabs digest={digest} classifications={classifications} />
    </main>
  )
}
