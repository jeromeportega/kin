"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { usePlaidLink, type PlaidLinkOnSuccess } from "react-plaid-link"

// Connect a bank via Plaid Link and sync its transactions. Fetches a Link token
// from our server, opens Plaid Link, then hands the public_token back to
// /api/finance/plaid/exchange (which stores the Item and pulls an initial sync).
export function PlaidConnect({ hasBank }: { hasBank: boolean }) {
  const router = useRouter()
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    async (publicToken, metadata) => {
      setBusy(true)
      setMsg(null)
      setLinkToken(null)
      try {
        const res = await fetch("/api/finance/plaid/exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            public_token: publicToken,
            institution: metadata.institution
              ? { id: metadata.institution.institution_id, name: metadata.institution.name }
              : undefined,
          }),
        })
        const data = (await res.json()) as { ok?: boolean; added?: number; error?: string }
        if (res.ok && data.ok) {
          setMsg(`Connected — synced ${data.added ?? 0} transactions.`)
          router.refresh()
        } else {
          setMsg(`Connect failed: ${data.error ?? res.status}`)
        }
      } catch (e) {
        setMsg(`Connect failed: ${String(e)}`)
      } finally {
        setBusy(false)
      }
    },
    [router],
  )

  const { open, ready } = usePlaidLink({ token: linkToken, onSuccess })

  // Open Link the moment we have a token and the widget is ready.
  useEffect(() => {
    if (linkToken && ready) open()
  }, [linkToken, ready, open])

  const startConnect = useCallback(async () => {
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch("/api/finance/plaid/link-token", { method: "POST" })
      const data = (await res.json()) as { link_token?: string; error?: string }
      if (res.ok && data.link_token) {
        setLinkToken(data.link_token)
      } else {
        setMsg(`Could not start Plaid: ${data.error ?? res.status}`)
        setBusy(false)
      }
    } catch (e) {
      setMsg(`Could not start Plaid: ${String(e)}`)
      setBusy(false)
    }
  }, [])

  const sync = useCallback(async () => {
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch("/api/finance/plaid/sync", { method: "POST" })
      const data = (await res.json()) as {
        ok?: boolean
        added?: number
        skippedDuplicates?: number
        error?: string
      }
      if (res.ok && data.ok) {
        setMsg(`Synced ${data.added ?? 0} new transactions (${data.skippedDuplicates ?? 0} already had).`)
        router.refresh()
      } else {
        setMsg(`Sync failed: ${data.error ?? res.status}`)
      }
    } catch (e) {
      setMsg(`Sync failed: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }, [router])

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm">
      <button
        type="button"
        onClick={() => void startConnect()}
        disabled={busy}
        className="rounded-md border px-3 py-1.5 font-medium disabled:opacity-50"
      >
        {hasBank ? "Connect another bank" : "Connect a bank"}
      </button>
      {hasBank && (
        <button
          type="button"
          onClick={() => void sync()}
          disabled={busy}
          className="rounded-md border px-3 py-1.5 font-medium disabled:opacity-50"
        >
          Sync now
        </button>
      )}
      {busy && <span className="text-muted-foreground">Working…</span>}
      {msg && <span className="text-muted-foreground">{msg}</span>}
    </div>
  )
}
