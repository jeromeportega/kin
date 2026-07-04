"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import type { QueueItem } from "@/lib/finance/core/queue/types"

// Confirm / Dismiss buttons for one review-queue row. Posts the decision to
// /api/finance/queue/decision; on success the item drops from the queue and we
// refresh the server component to reflect it.
export function QueueItemActions({ item }: { item: QueueItem }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  async function decide(action: "confirm" | "dismiss") {
    setBusy(true)
    setError(false)
    try {
      const res = await fetch("/api/finance/queue/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId: item.id, itemType: item.type, action }),
      })
      if (res.ok) {
        router.refresh()
      } else {
        setError(true)
        setBusy(false)
      }
    } catch {
      setError(true)
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => void decide("confirm")}
        className="rounded-md border px-2 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
      >
        Confirm
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void decide("dismiss")}
        className="rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
      >
        Dismiss
      </button>
      {error && <span className="text-xs text-destructive">failed</span>}
    </div>
  )
}
