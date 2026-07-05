"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

type ImportResult =
  | { ok: true; connected: false }
  | {
      ok: true
      connected: true
      inserted: { transactions: number; orders: number; orderItems: number; storeCreditRows: number }
      skippedDuplicates: number
      errors?: { rowRef: string; reason: string }[]
    }
  | { ok: false; error: string }

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
      if (!res.ok) {
        setMsg(`Import failed (${res.status})`)
        return
      }
      const body = (await res.json()) as unknown
      if (typeof (body as Record<string, unknown>).ok !== "boolean") {
        setMsg("Import failed: unexpected response")
        return
      }
      const data = body as ImportResult
      if (!data.ok) {
        setMsg(data.error)
        return
      }
      if (!data.connected) {
        setConnectGmail(true)
        return
      }
      const { inserted, skippedDuplicates, errors } = data
      const parts: string[] = [`${inserted.orders} orders`, `${inserted.orderItems} items`]
      if (inserted.transactions > 0) parts.push(`${inserted.transactions} transactions`)
      if (inserted.storeCreditRows > 0) parts.push(`${inserted.storeCreditRows} store credit rows`)
      // Surface emails that were skipped (unrecognized, unparseable, or failed the
      // reconciliation guard) so silently-dropped receipts are visible.
      const skippedEmails = errors?.length
        ? ` — ${errors.length} email${errors.length === 1 ? "" : "s"} skipped (couldn't parse).`
        : ""
      setMsg(`Imported ${parts.join(", ")} (${skippedDuplicates} duplicates skipped).${skippedEmails}`)
      router.refresh()
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
          <a href="/api/auth/signin/google?callbackUrl=/finance" className="underline">
            Connect Gmail
          </a>
        </span>
      )}
      {msg && <span className="text-muted-foreground">{msg}</span>}
    </div>
  )
}
