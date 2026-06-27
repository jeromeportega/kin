"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import type { UnfamiliarSender } from "@/lib/tuning"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

type Phase = "idle" | "reviewing" | "submitting" | "done" | "error"

interface Added {
  sender_allowlist: number
  sender_blocklist: number
}

export function TuningPrompt({ senders }: { senders: UnfamiliarSender[] }) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>("idle")
  const [index, setIndex] = useState(0)
  const [allow, setAllow] = useState<string[]>([])
  const [block, setBlock] = useState<string[]>([])
  const [added, setAdded] = useState<Added | null>(null)

  // Cadence: nothing unfamiliar → the prompt hides itself.
  if (senders.length === 0) return null

  async function submit(finalAllow: string[], finalBlock: string[]) {
    setPhase("submitting")
    try {
      const res = await fetch("/api/tune", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allow: finalAllow, block: finalBlock }),
      })
      if (!res.ok) throw new Error("tune failed")
      const data = (await res.json()) as { added: Added }
      setAdded(data.added)
      setPhase("done")
      router.refresh()
    } catch {
      setPhase("error")
    }
  }

  function decide(action: "keep" | "mute" | "skip") {
    const sender = senders[index]
    const nextAllow = action === "keep" ? [...allow, sender.address] : allow
    const nextBlock = action === "mute" ? [...block, sender.address] : block
    setAllow(nextAllow)
    setBlock(nextBlock)
    if (index + 1 >= senders.length) {
      submit(nextAllow, nextBlock)
    } else {
      setIndex(index + 1)
    }
  }

  const plural = senders.length === 1 ? "" : "s"

  return (
    <Card className="mb-6 border-dashed" role="region" aria-label="Tune your inbox">
      <CardHeader>
        <CardTitle className="text-base">Tune your inbox</CardTitle>
        <p className="text-sm text-muted-foreground">
          {phase === "done"
            ? `Saved — ${added?.sender_allowlist ?? 0} kept, ${added?.sender_blocklist ?? 0} muted. We'll only ask again when new senders show up.`
            : `We've classified mail from ${senders.length} sender${plural} you haven't told us about. Keep what matters, mute the noise.`}
        </p>
      </CardHeader>
      <CardContent>
        {phase === "idle" && (
          <Button onClick={() => setPhase("reviewing")}>
            Review {senders.length} sender{plural}
          </Button>
        )}

        {phase === "reviewing" && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {index + 1} of {senders.length}
            </p>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{senders[index].address}</span>
                <Badge variant="secondary">{senders[index].sampleCategory}</Badge>
                {senders[index].count > 1 && (
                  <span className="text-xs text-muted-foreground">
                    {senders[index].count} emails
                  </span>
                )}
              </div>
              <p className="text-sm">{senders[index].sampleSubject}</p>
              {senders[index].sampleSummary && (
                <p className="text-xs text-muted-foreground">{senders[index].sampleSummary}</p>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={() => decide("keep")}>Keep</Button>
              <Button variant="outline" onClick={() => decide("mute")}>
                Mute
              </Button>
              <Button variant="ghost" onClick={() => decide("skip")}>
                Skip
              </Button>
            </div>
          </div>
        )}

        {phase === "submitting" && <p className="text-sm text-muted-foreground">Saving…</p>}

        {phase === "error" && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-destructive">Couldn&apos;t save — try again.</span>
            <Button onClick={() => submit(allow, block)}>Retry</Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
