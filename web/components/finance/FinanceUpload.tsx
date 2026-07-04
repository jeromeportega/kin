"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

// Upload a bank statement (Excel/CSV) or Amazon order export (CSV) into your
// household. Lands the rows via /api/finance/ingest, then refreshes the queue.
export function FinanceUpload() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function upload(kind: "bank" | "amazon", file: File) {
    setBusy(true)
    setMsg(null)
    try {
      const form = new FormData()
      form.set("file", file)
      form.set("kind", kind)
      const res = await fetch("/api/finance/ingest", { method: "POST", body: form })
      const data = (await res.json()) as {
        ok?: boolean
        transactions?: number
        orders?: number
        skippedDuplicates?: number
        error?: string
      }
      if (res.ok && data.ok) {
        setMsg(
          `Imported ${data.transactions ?? 0} transactions, ${data.orders ?? 0} orders` +
            ` (${data.skippedDuplicates ?? 0} duplicates skipped).`
        )
        router.refresh()
      } else {
        setMsg(`Import failed: ${data.error ?? res.status}`)
      }
    } catch (e) {
      setMsg(`Import failed: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-4 rounded-lg border p-3 text-sm">
      <label className="flex items-center gap-2">
        <span className="font-medium">Bank statement</span>
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void upload("bank", f)
          }}
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="font-medium">Amazon orders</span>
        <input
          type="file"
          accept=".csv"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void upload("amazon", f)
          }}
        />
      </label>
      {busy && <span className="text-muted-foreground">Importing…</span>}
      {msg && <span className="text-muted-foreground">{msg}</span>}
    </div>
  )
}
