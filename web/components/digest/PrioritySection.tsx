import type { DigestItem } from "@/lib/types"
import {
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion"
import { CategoryGroup } from "./CategoryGroup"

interface PrioritySectionProps {
  priority: "high" | "medium" | "low"
  items: DigestItem[]
}

const PRIORITY_LABELS: Record<string, string> = {
  high: "High Priority",
  medium: "Medium Priority",
  low: "Low Priority",
}

function groupByCategory(items: DigestItem[]): Map<string, DigestItem[]> {
  const map = new Map<string, DigestItem[]>()
  for (const item of items) {
    const group = map.get(item.category) ?? []
    group.push(item)
    map.set(item.category, group)
  }
  return map
}

export function PrioritySection({ priority, items }: PrioritySectionProps) {
  if (items.length === 0) return null

  const byCategory = groupByCategory(items)

  return (
    <AccordionItem value={priority}>
      <AccordionTrigger>
        {PRIORITY_LABELS[priority]}
      </AccordionTrigger>
      <AccordionContent>
        <div className="space-y-6 pt-2">
          {Array.from(byCategory.entries()).map(([category, catItems]) => (
            <CategoryGroup key={category} category={category} items={catItems} />
          ))}
        </div>
      </AccordionContent>
    </AccordionItem>
  )
}
