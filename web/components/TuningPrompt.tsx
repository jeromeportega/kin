"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import type { UnfamiliarSender } from "@/lib/tuning"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

type Phase = "idle" | "senders" | "keywords" | "submitting" | "done" | "error"

interface Added {
  sender_allowlist: number
  sender_blocklist: number
  subject_keywords: number
}

export function TuningPrompt({
  senders,
  suggestedKeywords,
}: {
  senders: UnfamiliarSender[]
  suggestedKeywords: string[]
}) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>("idle")
  const [index, setIndex] = useState(0)
  const [allow, setAllow] = useState<string[]>([])
  const [block, setBlock] = useState<string[]>([])
  const [keywords, setKeywords] = useState<string[]>([])
  const [custom, setCustom] = useState("")
  const [added, setAdded] = useState<Added | null>(null)

  // Cadence: nothing unfamiliar and nothing to suggest → the prompt hides itself.
  if (senders.length === 0 && suggestedKeywords.length === 0) return null

  async function submit(a: string[], b: string[], k: string[]) {
    setPhase("submitting")
    try {
      const res = await fetch("/api/tune", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allow: a, block: b, keyword: k }),
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
    if (index + 1 >= senders.length) setPhase("keywords")
    else setIndex(index + 1)
  }

  function toggleKeyword(k: string) {
    setKeywords((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]))
  }

  function addCustom() {
    const k = custom.trim().toLowerCase()
    if (k && !keywords.includes(k)) setKeywords([...keywords, k])
    setCustom("")
  }

  const plural = senders.length === 1 ? "" : "s"

  return (
    <Card className="mb-6 border-dashed" role="region" aria-label="Tune your inbox">
      <CardHeader>
        <CardTitle className="text-base">Tune your inbox</CardTitle>
        <p className="text-sm text-muted-foreground">
          {phase === "done"
            ? `Saved — ${added?.sender_allowlist ?? 0} kept, ${added?.sender_blocklist ?? 0} muted, ${added?.subject_keywords ?? 0} keyword${added?.subject_keywords === 1 ? "" : "s"} added. We'll only ask again when something new shows up.`
            : senders.length > 0
              ? `We've classified mail from ${senders.length} sender${plural} you haven't told us about. Keep what matters, mute the noise.`
              : "A few subjects we could keep an eye on for you."}
        </p>
      </CardHeader>
      <CardContent>
        {phase === "idle" && (
          <Button onClick={() => setPhase(senders.length > 0 ? "senders" : "keywords")}>
            {senders.length > 0 ? `Review ${senders.length} sender${plural}` : "Pick subjects to watch"}
          </Button>
        )}

        {phase === "senders" && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {index + 1} of {senders.length}
            </p>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{senders[index].address}</span>
                <Badge variant="secondary">{senders[index].sampleCategory}</Badge>
                {senders[index].count > 1 && (
                  <span className="text-xs text-muted-foreground">{senders[index].count} emails</span>
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

        {phase === "keywords" && (
          <div className="space-y-3">
            <p className="text-sm">
              Always classify mail whose subject mentions these — even from unknown senders.
            </p>
            {suggestedKeywords.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {suggestedKeywords.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => toggleKeyword(k)}
                    aria-pressed={keywords.includes(k)}
                    className={`rounded-full border px-3 py-1 text-sm ${
                      keywords.includes(k) ? "bg-primary text-primary-foreground" : "bg-background"
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    addCustom()
                  }
                }}
                placeholder="Add a term…"
                aria-label="Add a subject keyword"
                className="flex-1 rounded-md border px-3 py-1 text-sm"
              />
              <Button variant="outline" onClick={addCustom}>
                Add
              </Button>
            </div>
            {keywords.length > 0 && (
              <p className="text-xs text-muted-foreground">Selected: {keywords.join(", ")}</p>
            )}
            <Button onClick={() => submit(allow, block, keywords)}>Save</Button>
          </div>
        )}

        {phase === "submitting" && <p className="text-sm text-muted-foreground">Saving…</p>}

        {phase === "error" && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-destructive">Couldn&apos;t save — try again.</span>
            <Button onClick={() => submit(allow, block, keywords)}>Retry</Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
