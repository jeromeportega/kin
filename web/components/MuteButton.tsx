"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"

// Per-email "mute this sender" — the in-flow way to refine the filter. Adds the
// sender to the blocklist; the page re-renders without that sender's mail.
export function MuteButton({ sender }: { sender: string }) {
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function mute() {
    setBusy(true)
    try {
      const res = await fetch("/api/mute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender }),
      })
      if (res.ok) router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={mute}
      disabled={busy}
      title={`Stop classifying mail from ${sender}`}
      className="h-7 text-xs text-muted-foreground"
    >
      {busy ? "Muting…" : "Mute sender"}
    </Button>
  )
}
