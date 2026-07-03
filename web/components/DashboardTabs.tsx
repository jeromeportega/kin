"use client"

import type { Classification, Digest, DigestItem } from "@/lib/types"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { DigestView } from "@/components/digest/DigestView"
import { DigestItemCard } from "@/components/digest/DigestItemCard"
import { EmptyState } from "@/components/digest/EmptyState"

type Priority = "high" | "medium" | "low"
const PRIORITIES: Priority[] = ["high", "medium", "low"]
const LABEL: Record<Priority, string> = { high: "High", medium: "Medium", low: "Low" }

// A Classification carries the same fields as a DigestItem except it names the
// email date `email_date`; map it so we can reuse DigestItemCard.
function toItem(c: Classification): DigestItem {
  return {
    classification_id: c.classification_id,
    message_id: c.message_id,
    uid: c.uid,
    from_addr: c.from_addr,
    subject: c.subject,
    date: c.email_date,
    category: c.category,
    priority: c.priority,
    action_required: c.action_required,
    summary: c.summary,
    action_items: c.action_items,
    dates: c.dates,
    links: c.links,
    confidence: c.confidence,
    model: c.model,
    prompt_version: c.prompt_version,
    classified_at: c.classified_at,
  }
}

function PriorityPanel({ items, label }: { items: DigestItem[]; label: string }) {
  if (items.length === 0) {
    return (
      <div
        role="region"
        aria-label={`No ${label} emails`}
        className="py-16 text-center text-sm text-muted-foreground"
      >
        No {label}-priority emails in this window.
      </div>
    )
  }
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <DigestItemCard key={item.classification_id} item={item} />
      ))}
    </div>
  )
}

export function DashboardTabs({
  digest,
  classifications,
}: {
  digest: Digest | null
  classifications: Classification[]
}) {
  // Group ALL classifications by priority — the priority tabs show everything the
  // classifier decided, including the low/other FYIs the curated digest hides.
  // Newest first within each tab.
  const byPriority: Record<Priority, DigestItem[]> = { high: [], medium: [], low: [] }
  for (const c of classifications) {
    if (c.priority in byPriority) byPriority[c.priority].push(toItem(c))
  }
  for (const p of PRIORITIES) {
    byPriority[p].sort((a, b) => b.date.localeCompare(a.date))
  }

  return (
    <Tabs defaultValue="digest">
      <TabsList>
        <TabsTab value="digest">Digest</TabsTab>
        {PRIORITIES.map((p) => (
          <TabsTab key={p} value={p}>
            {LABEL[p]} ({byPriority[p].length})
          </TabsTab>
        ))}
      </TabsList>

      <TabsPanel value="digest">
        {digest ? <DigestView digest={digest} /> : <EmptyState />}
      </TabsPanel>
      {PRIORITIES.map((p) => (
        <TabsPanel key={p} value={p}>
          <PriorityPanel items={byPriority[p]} label={LABEL[p].toLowerCase()} />
        </TabsPanel>
      ))}
    </Tabs>
  )
}
