import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"

import { QueueView } from "@/components/finance/queue/QueueView"

describe("QueueView", () => {
  it("renders the empty state (no table) when there are no items", () => {
    render(<QueueView items={[]} />)
    expect(screen.getByRole("region", { name: /review queue/i })).toBeInTheDocument()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })

  it("renders a table row per item", () => {
    const items = [
      {
        type: "unmatched_txn" as const,
        id: "t1",
        reason: "No matching order or receipt",
        amountCents: -1234,
      },
      {
        type: "flagged_receipt" as const,
        id: "r1",
        reason: "Arithmetic mismatch",
        amountCents: -5000,
      },
    ]
    // QueueItem carries more fields in practice; the view only reads these.
    render(<QueueView items={items as never} />)
    expect(screen.getByRole("table")).toBeInTheDocument()
    expect(screen.getByText(/No matching order or receipt/i)).toBeInTheDocument()
    expect(screen.getByText(/Arithmetic mismatch/i)).toBeInTheDocument()
  })
})
