import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

const mockSignIn = vi.hoisted(() => vi.fn())
vi.mock("next-auth/react", () => ({
  signIn: mockSignIn,
}))

const mockRouterRefresh = vi.hoisted(() => vi.fn())
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}))

import { SyncGmailButton } from "@/components/SyncGmailButton"

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal("fetch", vi.fn())
})

describe("SyncGmailButton", () => {
  // ─── AC4: button exists and calls route ───────────────────────────────────

  it("renders a 'Sync my Gmail' button", () => {
    render(<SyncGmailButton />)
    expect(screen.getByRole("button", { name: "Sync my Gmail" })).toBeInTheDocument()
  })

  it("POSTs to /api/sync on click", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    render(<SyncGmailButton />)
    fireEvent.click(screen.getByRole("button", { name: "Sync my Gmail" }))

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/sync", { method: "POST" })
    })
  })

  // ─── AC2: 200 response → refresh dashboard ────────────────────────────────

  it("calls router.refresh() on 200 success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    render(<SyncGmailButton />)
    fireEvent.click(screen.getByRole("button", { name: "Sync my Gmail" }))

    await waitFor(() => {
      expect(mockRouterRefresh).toHaveBeenCalledOnce()
    })
  })

  // ─── AC3: 409 {reauth:true} → re-auth action surfaced ────────────────────

  it("surfaces Re-authenticate button on 409 {reauth:true}", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ reauth: true }), { status: 409 })
    )

    render(<SyncGmailButton />)
    fireEvent.click(screen.getByRole("button", { name: "Sync my Gmail" }))

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /re-authenticate/i })).toBeInTheDocument()
    })
    expect(screen.queryByRole("button", { name: "Sync my Gmail" })).not.toBeInTheDocument()
  })

  it("calls signIn('google') with consent when Re-authenticate is clicked", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ reauth: true }), { status: 409 })
    )

    render(<SyncGmailButton />)
    fireEvent.click(screen.getByRole("button", { name: "Sync my Gmail" }))

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /re-authenticate/i })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole("button", { name: /re-authenticate/i }))

    expect(mockSignIn).toHaveBeenCalledWith(
      "google",
      expect.objectContaining({ callbackUrl: "/dashboard" }),
      expect.objectContaining({ prompt: "consent" })
    )
  })

  // ─── error state: non-200 non-409 ─────────────────────────────────────────

  it("does not call router.refresh() on 500 error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false }), { status: 500 })
    )

    render(<SyncGmailButton />)
    fireEvent.click(screen.getByRole("button", { name: "Sync my Gmail" }))

    await waitFor(() => {
      expect(fetch).toHaveBeenCalled()
    })

    expect(mockRouterRefresh).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: /re-authenticate/i })).not.toBeInTheDocument()
  })

  // ─── loading state ────────────────────────────────────────────────────────

  it("disables button and shows Syncing... while request is in flight", async () => {
    let resolveSync!: (value: Response) => void
    vi.mocked(fetch).mockReturnValueOnce(new Promise((r) => { resolveSync = r }))

    render(<SyncGmailButton />)
    fireEvent.click(screen.getByRole("button", { name: "Sync my Gmail" }))

    await waitFor(() => {
      const btn = screen.getByRole("button", { name: "Syncing..." })
      expect(btn).toBeInTheDocument()
      expect(btn).toBeDisabled()
    })

    // Resolve to avoid dangling promise
    resolveSync(new Response(JSON.stringify({ ok: true }), { status: 200 }))
  })

  // ─── error state: shows message and retry button ──────────────────────────

  it("shows error message and retry button on 500 error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false }), { status: 500 })
    )

    render(<SyncGmailButton />)
    fireEvent.click(screen.getByRole("button", { name: "Sync my Gmail" }))

    await waitFor(() => {
      expect(screen.getByText(/sync failed/i)).toBeInTheDocument()
    })
    expect(screen.getByRole("button", { name: "Sync my Gmail" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /re-authenticate/i })).not.toBeInTheDocument()
  })

  // ─── reauth state: cancel returns to idle ────────────────────────────────

  it("shows Cancel in reauth state and returns to idle when clicked", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ reauth: true }), { status: 409 })
    )

    render(<SyncGmailButton />)
    fireEvent.click(screen.getByRole("button", { name: "Sync my Gmail" }))

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sync my Gmail" })).toBeInTheDocument()
    })
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /re-authenticate/i })).not.toBeInTheDocument()
  })
})
