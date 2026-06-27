import type { Digest } from "@/lib/types"
import { Accordion } from "@/components/ui/accordion"
import { PrioritySection } from "./PrioritySection"
import { SummaryStats } from "./SummaryStats"

export function DigestView({ digest }: { digest: Digest }) {
  const high = digest.items.filter((i) => i.priority === "high")
  const medium = digest.items.filter((i) => i.priority === "medium")
  const low = digest.items.filter((i) => i.priority === "low")

  // Open all non-empty sections by default
  const defaultOpen = [
    high.length > 0 ? "high" : null,
    medium.length > 0 ? "medium" : null,
    low.length > 0 ? "low" : null,
  ].filter(Boolean) as string[]

  return (
    <div className="space-y-8">
      <SummaryStats digest={digest} />
      <Accordion multiple defaultValue={defaultOpen} className="space-y-2">
        <PrioritySection priority="high" items={high} />
        <PrioritySection priority="medium" items={medium} />
        <PrioritySection priority="low" items={low} />
      </Accordion>
    </div>
  )
}
