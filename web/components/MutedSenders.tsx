"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"

// Recovery view — the one explicit control we keep. Lets a mistaken mute be
// undone, which is what makes muting liberally feel safe.
export function MutedSenders({ senders }: { senders: string[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)

  if (senders.length === 0) return null

  async function unmute(sender: string) {
    setBusy(sender)
    try {
      const res = await fetch("/api/mute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender, unmute: true }),
      })
      if (res.ok) router.refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <details className="mt-8 text-sm text-muted-foreground">
      <summary className="cursor-pointer select-none">Muted senders ({senders.length})</summary>
      <ul className="mt-2 space-y-1">
        {senders.map((s) => (
          <li key={s} className="flex items-center justify-between gap-2">
            <span className="truncate">{s}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => unmute(s)}
              disabled={busy === s}
            >
              {busy === s ? "…" : "Unmute"}
            </Button>
          </li>
        ))}
      </ul>
    </details>
  )
}
