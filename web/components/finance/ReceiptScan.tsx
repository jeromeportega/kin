"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

// Scan a receipt photo or PDF into your household. Claude vision extracts the
// items server-side; the queue + true-spend then reflect the new receipt.
export function ReceiptScan() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function scan(file: File) {
    setBusy(true)
    setMsg(null)
    try {
      const form = new FormData()
      form.set("file", file)
      const res = await fetch("/api/finance/receipts/scan", { method: "POST", body: form })
      const data = (await res.json()) as {
        ok?: boolean
        store?: string | null
        totalCents?: number | null
        itemCount?: number
        status?: string
        idempotent?: boolean
        error?: string
      }
      if (res.ok && data.ok) {
        if (data.idempotent) {
          setMsg("Already scanned this receipt — no changes.")
        } else {
          const total = typeof data.totalCents === "number" ? ` ($${(data.totalCents / 100).toFixed(2)})` : ""
          const review = data.status === "needs_review" ? " — flagged for review" : ""
          setMsg(`Scanned ${data.store ?? "receipt"}: ${data.itemCount ?? 0} items${total}${review}.`)
        }
        router.refresh()
      } else {
        setMsg(`Scan failed: ${data.error ?? res.status}`)
      }
    } catch (e) {
      setMsg(`Scan failed: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm">
      <label className="flex items-center gap-2">
        <span className="font-medium">Scan a receipt</span>
        <input
          type="file"
          accept="image/jpeg,image/png,application/pdf"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void scan(f)
          }}
        />
      </label>
      {busy && <span className="text-muted-foreground">Reading receipt…</span>}
      {msg && <span className="text-muted-foreground">{msg}</span>}
    </div>
  )
}
