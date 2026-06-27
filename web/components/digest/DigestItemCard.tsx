"use client"

import type { DigestItem } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

function formatLocalTime(iso: string): string {
  return new Date(iso).toLocaleString()
}

const PRIORITY_VARIANT: Record<
  DigestItem["priority"],
  "destructive" | "default" | "secondary"
> = {
  high: "destructive",
  medium: "default",
  low: "secondary",
}

export function DigestItemCard({ item }: { item: DigestItem }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-medium">{item.subject}</CardTitle>
          <Badge variant={PRIORITY_VARIANT[item.priority]}>{item.priority}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">{item.from_addr}</p>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm">{item.summary}</p>
        {item.action_items.length > 0 && (
          <ul className="list-disc pl-4 text-sm">
            {item.action_items.map((action, i) => (
              <li key={i}>{action}</li>
            ))}
          </ul>
        )}
        {item.dates.length > 0 && (
          <ul className="list-none text-xs text-muted-foreground">
            {item.dates.map((date, i) => (
              <li key={i}>{date}</li>
            ))}
          </ul>
        )}
        <time
          className="block text-xs text-muted-foreground"
          dateTime={item.date}
        >
          {formatLocalTime(item.date)}
        </time>
      </CardContent>
    </Card>
  )
}
