"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import type { QueueItem } from "@/lib/finance/core/queue/types"

// Confirm / Correct / Dismiss for one review-queue row. Posts the decision to
// /api/finance/queue/decision; on success the item drops from the queue and we
// refresh the server component. "Correct" opens an inline category picker
// (pickCategoryId) — the broadly-applicable correction; richer per-type
// corrections (pick-match-candidate, edit-resolution) land as item-level retailer
// data arrives.
export function QueueItemActions({ item, categories }: { item: QueueItem; categories: string[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [correcting, setCorrecting] = useState(false)
  const [category, setCategory] = useState(categories[0] ?? "")

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(false)
    try {
      const res = await fetch("/api/finance/queue/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId: item.id, itemType: item.type, ...body }),
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

  const btn =
    "rounded-md border px-2 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"

  if (correcting) {
    return (
      <div className="flex items-center justify-end gap-2">
        <select
          aria-label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          disabled={busy}
          className="rounded-md border bg-background px-2 py-1 text-xs"
        >
          {categories.map((c) => (
            <option key={c} value={c}>
              {c.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy}
          onClick={() => void post({ action: "correct", categoryId: category })}
          className={btn}
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setCorrecting(false)}
          className={`${btn} text-muted-foreground`}
        >
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <button type="button" disabled={busy} onClick={() => void post({ action: "confirm" })} className={btn}>
        Confirm
      </button>
      <button type="button" disabled={busy} onClick={() => setCorrecting(true)} className={btn}>
        Correct
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void post({ action: "dismiss" })}
        className={`${btn} text-muted-foreground`}
      >
        Dismiss
      </button>
      {error && <span className="text-xs text-destructive">failed</span>}
    </div>
  )
}
