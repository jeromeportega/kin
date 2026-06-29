import { redirect } from "next/navigation"
import { resolveScope } from "@/lib/scope"
import { fetchDigest, fetchClassifications } from "@/lib/api"
import { readKinConfig } from "@/lib/kinConfig"
import { unfamiliarSenders, suggestKeywords } from "@/lib/tuning"
import { senderMatches } from "@/lib/filter"
import { DashboardTabs } from "@/components/DashboardTabs"
import { TuningPrompt } from "@/components/TuningPrompt"
import { MutedSenders } from "@/components/MutedSenders"
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
    readKinConfig(userId),
  ])

  // Hide muted senders immediately. Their mail was classified before the mute;
  // the next sync stops fetching them entirely.
  const blocked = config.sender_blocklist
  const visible = classifications.filter((c) => !senderMatches(c.from_addr, blocked))
  const visibleDigest = digest
    ? { ...digest, items: digest.items.filter((i) => !senderMatches(i.from_addr, blocked)) }
    : null

  // The tuning prompt is the old opt-in (allowlist) flow — only meaningful in
  // strict mode. In loose mode users refine by muting, so suppress it.
  const strictMode =
    config.sender_allowlist.length > 0 || config.subject_keywords.length > 0
  const unfamiliar = strictMode ? unfamiliarSenders(visible, config) : []
  const suggestedKeywords = strictMode ? suggestKeywords(visible, config) : []

  return (
    <main className="container mx-auto max-w-4xl py-8 px-4">
      <div className="mb-4 flex justify-end gap-2">
        <SyncGmailButton />
        <SignOutButton />
      </div>
      <TuningPrompt senders={unfamiliar} suggestedKeywords={suggestedKeywords} />
      <DashboardTabs digest={visibleDigest} classifications={visible} />
      <MutedSenders senders={blocked} />
    </main>
  )
}
