import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

const mockRefresh = vi.hoisted(() => vi.fn())
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}))

import { TuningPrompt } from "@/components/TuningPrompt"
import type { UnfamiliarSender } from "@/lib/tuning"

function sender(over: Partial<UnfamiliarSender>): UnfamiliarSender {
  return {
    address: "a@x.com",
    domain: "x.com",
    count: 1,
    sampleSubject: "Subject",
    sampleCategory: "finance",
    sampleSummary: "A summary",
    latest: "2026-06-26T10:00:00+00:00",
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal("fetch", vi.fn())
})

describe("TuningPrompt", () => {
  it("renders nothing when there are no unfamiliar senders", () => {
    const { container } = render(<TuningPrompt senders={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("prompts to review when senders are present", () => {
    render(<TuningPrompt senders={[sender({})]} />)
    expect(screen.getByRole("region", { name: /tune your inbox/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /review 1 sender/i })).toBeInTheDocument()
  })

  it("walks senders and POSTs allow/mute decisions to /api/tune", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, added: { sender_allowlist: 1, sender_blocklist: 1 } }), { status: 200 })
    )
    render(
      <TuningPrompt
        senders={[sender({ address: "keep@x.com" }), sender({ address: "mute@y.com", domain: "y.com" })]}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /review 2 senders/i }))
    expect(screen.getByText("keep@x.com")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Keep" }))
    expect(screen.getByText("mute@y.com")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Mute" }))

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tune", expect.objectContaining({ method: "POST" })))
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
    expect(body.allow).toEqual(["keep@x.com"])
    expect(body.block).toEqual(["mute@y.com"])
    await waitFor(() => expect(screen.getByText(/saved/i)).toBeInTheDocument())
    expect(mockRefresh).toHaveBeenCalled()
  })
})
