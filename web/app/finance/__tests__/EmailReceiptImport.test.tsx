import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

const mockRouterRefresh = vi.hoisted(() => vi.fn())
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}))

import { EmailReceiptImport } from "@/app/finance/EmailReceiptImport"

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal("fetch", vi.fn())
})

describe("EmailReceiptImport", () => {
  // ── Control present & wired ──────────────────────────────────────────────

  it("renders 'Import receipts from email' button", () => {
    render(<EmailReceiptImport />)
    expect(
      screen.getByRole("button", { name: /import receipts from email/i })
    ).toBeInTheDocument()
  })

  it("POSTs to /api/finance/import-email on click", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, connected: true, inserted: { transactions: 0, orders: 1, orderItems: 2, storeCreditRows: 0 }, skippedDuplicates: 0 }),
        { status: 200 }
      )
    )

    render(<EmailReceiptImport />)
    fireEvent.click(screen.getByRole("button", { name: /import receipts from email/i }))

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/finance/import-email", { method: "POST" })
    })
  })

  // ── Success → queue update ───────────────────────────────────────────────

  it("on connected:true response, shows success message and refreshes the route", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          connected: true,
          inserted: { transactions: 0, orders: 3, orderItems: 5, storeCreditRows: 0 },
          skippedDuplicates: 1,
        }),
        { status: 200 }
      )
    )

    render(<EmailReceiptImport />)
    fireEvent.click(screen.getByRole("button", { name: /import receipts from email/i }))

    await waitFor(() => {
      expect(screen.getByText(/3 orders/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/5 items/i)).toBeInTheDocument()
    expect(screen.getByText(/1 duplicates skipped/i)).toBeInTheDocument()
    expect(mockRouterRefresh).toHaveBeenCalledOnce()
  })

  // ── Connect-Gmail state (FR-8) ───────────────────────────────────────────

  it("on connected:false, shows 'connect Gmail' message and no error styling", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, connected: false }), { status: 200 })
    )

    render(<EmailReceiptImport />)
    fireEvent.click(screen.getByRole("button", { name: /import receipts from email/i }))

    await waitFor(() => {
      expect(screen.getByText(/connect gmail to import email receipts/i)).toBeInTheDocument()
    })
    // No error/500-type messaging
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument()
    // router.refresh not called — no import happened
    expect(mockRouterRefresh).not.toHaveBeenCalled()
  })

  // ── Loading / disabled state ─────────────────────────────────────────────

  it("button is disabled and shows pending label while request is in-flight", async () => {
    let resolve!: (value: Response) => void
    vi.mocked(fetch).mockReturnValueOnce(new Promise((r) => { resolve = r }))

    render(<EmailReceiptImport />)
    fireEvent.click(screen.getByRole("button", { name: /import receipts from email/i }))

    // The button is now in pending state
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /importing/i })
      expect(btn).toBeInTheDocument()
      expect(btn).toBeDisabled()
    })

    // Clicking again while disabled must not fire a second fetch
    fireEvent.click(screen.getByRole("button", { name: /importing/i }))
    expect(fetch).toHaveBeenCalledTimes(1)

    // Resolve to clean up
    resolve(
      new Response(
        JSON.stringify({ ok: true, connected: true, inserted: { transactions: 0, orders: 0, orderItems: 0, storeCreditRows: 0 }, skippedDuplicates: 0 }),
        { status: 200 }
      )
    )

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /import receipts from email/i })).not.toBeDisabled()
    })
  })

  // ── Non-401 server error ─────────────────────────────────────────────────

  it("on a non-401 server error (e.g. 500), shows an error message and does not call router.refresh", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 })
    )

    render(<EmailReceiptImport />)
    fireEvent.click(screen.getByRole("button", { name: /import receipts from email/i }))

    await waitFor(() => {
      expect(screen.getByText(/import failed \(500\)/i)).toBeInTheDocument()
    })
    expect(mockRouterRefresh).not.toHaveBeenCalled()
  })

  // ── 401 handled gracefully ───────────────────────────────────────────────

  it("on 401, shows session-expired message and does not call router.refresh", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Unauthenticated" }), { status: 401 })
    )

    render(<EmailReceiptImport />)
    fireEvent.click(screen.getByRole("button", { name: /import receipts from email/i }))

    await waitFor(() => {
      expect(screen.getByText(/sign in/i)).toBeInTheDocument()
    })
    expect(mockRouterRefresh).not.toHaveBeenCalled()
  })
})
