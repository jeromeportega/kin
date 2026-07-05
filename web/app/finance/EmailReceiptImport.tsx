"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

type ImportResult =
  | { ok: true; connected: false }
  | { ok: true; connected: true; inserted: { transactions: number; orders: number; orderItems: number; storeCreditRows: number }; skippedDuplicates: number }

export function EmailReceiptImport() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [connectGmail, setConnectGmail] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function importEmail() {
    setBusy(true)
    setConnectGmail(false)
    setMsg(null)
    try {
      const res = await fetch("/api/finance/import-email", { method: "POST" })
      if (res.status === 401) {
        setMsg("Session expired — please sign in again.")
        return
      }
      const data = (await res.json()) as ImportResult
      if (data.ok && !data.connected) {
        setConnectGmail(true)
        return
      }
      if (data.ok && data.connected) {
        const { inserted, skippedDuplicates } = data
        setMsg(
          `Imported ${inserted.orders} orders, ${inserted.orderItems} items` +
            ` (${skippedDuplicates} duplicates skipped).`
        )
        router.refresh()
      }
    } catch (e) {
      setMsg(`Import failed: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-4 rounded-lg border p-3 text-sm">
      <button
        type="button"
        onClick={() => void importEmail()}
        disabled={busy}
        className="rounded-md border px-3 py-1.5 font-medium disabled:opacity-50"
      >
        {busy ? "Importing…" : "Import receipts from email"}
      </button>
      {connectGmail && (
        <span>
          Connect Gmail to import email receipts.{" "}
          <a href="/api/auth/signin" className="underline">
            Connect Gmail
          </a>
        </span>
      )}
      {msg && <span className="text-muted-foreground">{msg}</span>}
    </div>
  )
}
