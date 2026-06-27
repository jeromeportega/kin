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
      <Button
        onClick={() =>
          signIn("google", { callbackUrl: "/dashboard" }, { prompt: "consent", access_type: "offline" })
        }
      >
        Re-authenticate with Google
      </Button>
    )
  }

  return (
    <Button onClick={handleSync} disabled={state === "syncing"}>
      {state === "syncing" ? "Syncing..." : "Sync my Gmail"}
    </Button>
  )
}
