"use client"

import type { DigestItem } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { MuteButton } from "@/components/MuteButton"
import { buttonVariants } from "@/components/ui/button"
import { extractAddress } from "@/lib/filter"
import { gmailSearchUrl, gmailComposeUrl } from "@/lib/gmailLinks"

const linkClass = buttonVariants({ variant: "ghost", size: "sm" }) + " h-7 text-xs text-muted-foreground"
const ctaClass = buttonVariants({ variant: "default", size: "sm" }) + " h-8"

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
        {item.links.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {item.links.map((link, i) => (
              <a
                key={i}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className={ctaClass}
              >
                {link.label} ↗
              </a>
            ))}
          </div>
        )}
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
        <div className="flex flex-wrap items-center justify-end gap-1">
          <a
            href={gmailSearchUrl(item.message_id)}
            target="_blank"
            rel="noopener noreferrer"
            className={linkClass}
          >
            Open in Gmail
          </a>
          <a
            href={gmailComposeUrl({ to: extractAddress(item.from_addr), subject: item.subject })}
            target="_blank"
            rel="noopener noreferrer"
            className={linkClass}
          >
            Reply
          </a>
          <MuteButton sender={extractAddress(item.from_addr)} />
        </div>
      </CardContent>
    </Card>
  )
}
