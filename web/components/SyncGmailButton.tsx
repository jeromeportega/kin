"use client"

import { useState } from "react"
import { signIn } from "next-auth/react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"

type SyncState = "idle" | "syncing" | "reauth" | "error"

export function SyncGmailButton() {
  const [state, setState] = useState<SyncState>("idle")
  const router = useRouter()

  async function handleSync() {
    setState("syncing")
    try {
      const res = await fetch("/api/sync", { method: "POST" })
      if (res.ok) {
        setState("idle")
        router.refresh()
      } else if (res.status === 409) {
        const data = await res.json()
        if (data.reauth) {
          setState("reauth")
        } else {
          setState("error")
        }
      } else {
        setState("error")
      }
    } catch {
      setState("error")
    }
  }

  if (state === "reauth") {
    return (
      <div className="flex gap-2">
        <Button
          onClick={() =>
            signIn("google", { callbackUrl: "/dashboard" }, { prompt: "consent", access_type: "offline" })
          }
        >
          Re-authenticate with Google
        </Button>
        <Button variant="outline" onClick={() => setState("idle")}>
          Cancel
        </Button>
      </div>
    )
  }

  if (state === "error") {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-destructive">Sync failed — please try again</span>
        <Button onClick={handleSync}>Sync my Gmail</Button>
      </div>
    )
  }

  return (
    <Button onClick={handleSync} disabled={state === "syncing"}>
      {state === "syncing" ? "Syncing..." : "Sync my Gmail"}
    </Button>
  )
}
