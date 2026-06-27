import type { DigestItem } from "@/lib/types"
import { DigestItemCard } from "./DigestItemCard"

interface CategoryGroupProps {
  category: string
  items: DigestItem[]
}

export function CategoryGroup({ category, items }: CategoryGroupProps) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {category}
      </h3>
      <div className="space-y-2">
        {items.map((item) => (
          <DigestItemCard key={item.classification_id} item={item} />
        ))}
      </div>
    </div>
  )
}
