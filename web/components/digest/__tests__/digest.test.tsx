import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, within } from "@testing-library/react"
import type { Digest, DigestItem } from "@/lib/types"

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<DigestItem> = {}): DigestItem {
  return {
    classification_id: 1,
    message_id: "msg-1",
    uid: null,
    from_addr: "alice@example.com",
    subject: "Q3 Budget Review",
    date: "2024-03-15T14:30:00Z",
    category: "finance",
    priority: "high",
    action_required: true,
    summary: "Review the Q3 budget figures before the meeting.",
    action_items: ["Approve budget", "Forward to CFO"],
    dates: ["March 20", "End of quarter"],
    confidence: 0.95,
    model: "gpt-4",
    prompt_version: "v1",
    classified_at: "2024-03-15T15:00:00Z",
    ...overrides,
  }
}

function makeDigest(overrides: Partial<Digest> = {}): Digest {
  return {
    generated_at: "2024-03-15T15:00:00Z",
    user_id: "jerome",
    model: "gpt-4",
    prompt_version: "v1",
    window_hours: 24,
    window_start: "2024-03-14T15:00:00Z",
    window_end: "2024-03-15T15:00:00Z",
    include_other: false,
    classified_count: 3,
    actionable_count: 2,
    informational_count: 1,
    skipped_other_count: 0,
    dropped_low_count: 0,
    items: [
      makeItem({ classification_id: 1, priority: "high", category: "finance", subject: "Q3 Budget Review" }),
      makeItem({ classification_id: 2, priority: "high", category: "legal", subject: "Contract Renewal" }),
      makeItem({ classification_id: 3, priority: "medium", category: "engineering", subject: "Deploy Schedule" }),
      makeItem({ classification_id: 4, priority: "low", category: "hr", subject: "Team Lunch" }),
    ],
    ...overrides,
  }
}

// ─── DigestView ───────────────────────────────────────────────────────────────

import { DigestView } from "@/components/digest/DigestView"

describe("DigestView — priority sections grouped by category", () => {
  it("renders all three priority sections when digest has high/medium/low items", () => {
    render(<DigestView digest={makeDigest()} />)

    expect(screen.getByText("High Priority")).toBeInTheDocument()
    expect(screen.getByText("Medium Priority")).toBeInTheDocument()
    expect(screen.getByText("Low Priority")).toBeInTheDocument()
  })

  it("groups items by category within each priority section", () => {
    render(<DigestView digest={makeDigest()} />)

    // High priority has two categories: finance and legal
    expect(screen.getByText("finance")).toBeInTheDocument()
    expect(screen.getByText("legal")).toBeInTheDocument()
    // Medium priority has engineering
    expect(screen.getByText("engineering")).toBeInTheDocument()
    // Low priority has hr
    expect(screen.getByText("hr")).toBeInTheDocument()
  })

  it("renders items for multiple categories under the same priority", () => {
    const digest = makeDigest({
      items: [
        makeItem({ classification_id: 1, priority: "high", category: "finance", subject: "Finance Email" }),
        makeItem({ classification_id: 2, priority: "high", category: "legal", subject: "Legal Email" }),
      ],
      classified_count: 2,
      actionable_count: 2,
      informational_count: 0,
    })
    render(<DigestView digest={digest} />)

    expect(screen.getByText("Finance Email")).toBeInTheDocument()
    expect(screen.getByText("Legal Email")).toBeInTheDocument()
  })

  it("does not render a priority section when that priority has no items", () => {
    const digest = makeDigest({
      items: [
        makeItem({ classification_id: 1, priority: "high", category: "work", subject: "High Only" }),
      ],
      classified_count: 1,
      actionable_count: 1,
      informational_count: 0,
    })
    render(<DigestView digest={digest} />)

    expect(screen.getByText("High Priority")).toBeInTheDocument()
    expect(screen.queryByText("Medium Priority")).not.toBeInTheDocument()
    expect(screen.queryByText("Low Priority")).not.toBeInTheDocument()
  })
})

describe("DigestView — item detail", () => {
  it("shows subject for each item", () => {
    render(<DigestView digest={makeDigest()} />)

    expect(screen.getByText("Q3 Budget Review")).toBeInTheDocument()
    expect(screen.getByText("Contract Renewal")).toBeInTheDocument()
    expect(screen.getByText("Deploy Schedule")).toBeInTheDocument()
    expect(screen.getByText("Team Lunch")).toBeInTheDocument()
  })

  it("shows sender (from_addr) for each item", () => {
    render(<DigestView digest={makeDigest()} />)

    // All items share the same from_addr in this fixture
    const senders = screen.getAllByText("alice@example.com")
    expect(senders.length).toBeGreaterThan(0)
  })

  it("shows summary for each item", () => {
    render(<DigestView digest={makeDigest()} />)

    const summaries = screen.getAllByText("Review the Q3 budget figures before the meeting.")
    expect(summaries.length).toBeGreaterThan(0)
  })

  it("shows multiple action_items as list entries", () => {
    const item = makeItem({
      classification_id: 10,
      priority: "high",
      category: "work",
      action_items: ["Reply by Friday", "CC the manager", "Update the tracker"],
    })
    render(<DigestView digest={makeDigest({ items: [item], classified_count: 1, actionable_count: 1, informational_count: 0 })} />)

    expect(screen.getByText("Reply by Friday")).toBeInTheDocument()
    expect(screen.getByText("CC the manager")).toBeInTheDocument()
    expect(screen.getByText("Update the tracker")).toBeInTheDocument()
  })

  it("shows extracted dates for each item", () => {
    const item = makeItem({
      classification_id: 11,
      priority: "high",
      category: "work",
      dates: ["March 20", "April 1"],
    })
    render(<DigestView digest={makeDigest({ items: [item], classified_count: 1, actionable_count: 1, informational_count: 0 })} />)

    expect(screen.getByText("March 20")).toBeInTheDocument()
    expect(screen.getByText("April 1")).toBeInTheDocument()
  })
})

describe("DigestView — summary stats", () => {
  it("renders classified_count", () => {
    render(<DigestView digest={makeDigest({ classified_count: 42 })} />)
    expect(screen.getByText("42")).toBeInTheDocument()
  })

  it("renders actionable_count", () => {
    render(<DigestView digest={makeDigest({ actionable_count: 17 })} />)
    expect(screen.getByText("17")).toBeInTheDocument()
  })

  it("renders informational_count", () => {
    render(<DigestView digest={makeDigest({ informational_count: 5 })} />)
    expect(screen.getByText("5")).toBeInTheDocument()
  })

  it("renders stat labels", () => {
    render(<DigestView digest={makeDigest()} />)
    expect(screen.getByText("Classified")).toBeInTheDocument()
    expect(screen.getByText("Actionable")).toBeInTheDocument()
    expect(screen.getByText("Informational")).toBeInTheDocument()
  })
})

describe("DigestView — local time rendering", () => {
  it("renders email date in local time, not the raw ISO string", () => {
    const iso = "2024-03-15T14:30:00Z"
    const item = makeItem({ classification_id: 99, priority: "high", category: "work", date: iso })
    render(
      <DigestView
        digest={makeDigest({ items: [item], classified_count: 1, actionable_count: 1, informational_count: 0 })}
      />
    )

    // Raw ISO must not appear as visible text
    expect(screen.queryByText(iso)).not.toBeInTheDocument()

    // A <time> element with the ISO as the dateTime attribute must be present
    const timeEl = document.querySelector(`time[dateTime="${iso}"]`)
    expect(timeEl).not.toBeNull()

    // The text content of the time element must differ from the raw ISO
    expect(timeEl!.textContent).not.toBe(iso)
    expect(timeEl!.textContent!.length).toBeGreaterThan(0)
  })
})

describe("DigestView — boundary: empty action_items and dates", () => {
  it("renders without crashing when action_items is empty", () => {
    const item = makeItem({ classification_id: 20, priority: "high", category: "work", action_items: [] })
    expect(() =>
      render(
        <DigestView
          digest={makeDigest({ items: [item], classified_count: 1, actionable_count: 0, informational_count: 1 })}
        />
      )
    ).not.toThrow()
  })

  it("renders without crashing when dates is empty", () => {
    const item = makeItem({ classification_id: 21, priority: "medium", category: "work", dates: [] })
    expect(() =>
      render(
        <DigestView
          digest={makeDigest({ items: [item], classified_count: 1, actionable_count: 1, informational_count: 0 })}
        />
      )
    ).not.toThrow()
  })

  it("does not render empty bullet for empty action_items", () => {
    const item = makeItem({ classification_id: 22, priority: "low", category: "work", subject: "Boundary Test", action_items: [], dates: [] })
    const { container } = render(
      <DigestView
        digest={makeDigest({ items: [item], classified_count: 1, actionable_count: 0, informational_count: 1 })}
      />
    )
    // No list items should appear (no action_items, no dates)
    const listItems = container.querySelectorAll("li")
    expect(listItems.length).toBe(0)
  })
})

// ─── EmptyState ───────────────────────────────────────────────────────────────

import { EmptyState } from "@/components/digest/EmptyState"

describe("EmptyState", () => {
  it("renders a clear empty-state message", () => {
    render(<EmptyState />)
    expect(screen.getByText(/no digest yet/i)).toBeInTheDocument()
    expect(screen.getByRole("region", { name: /no digest/i })).toBeInTheDocument()
  })

  it("does not render error UI", () => {
    render(<EmptyState />)
    // No alert role, no error text
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument()
  })
})

// ─── DashboardPage — empty state with fetchDigest mocked ─────────────────────

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/scope", () => ({
  resolveScope: vi.fn().mockResolvedValue("jerome"),
}))
vi.mock("@/lib/api", () => ({
  fetchDigest: vi.fn(),
  fetchClassifications: vi.fn(),
}))

import DashboardPage from "@/app/dashboard/page"
import { fetchDigest } from "@/lib/api"

describe("DashboardPage — empty state (fetchDigest mocked to null)", () => {
  beforeEach(() => {
    vi.mocked(fetchDigest).mockResolvedValue(null)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("renders the empty state when fetchDigest returns null", async () => {
    const jsx = await DashboardPage()
    render(jsx)

    expect(screen.getByText(/no digest yet/i)).toBeInTheDocument()
    expect(screen.getByRole("region", { name: /no digest/i })).toBeInTheDocument()
  })

  it("does not render error UI when fetchDigest returns null", async () => {
    const jsx = await DashboardPage()
    render(jsx)

    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument()
  })

  it("renders DigestView when fetchDigest returns a populated digest", async () => {
    const digest = makeDigest()
    vi.mocked(fetchDigest).mockResolvedValueOnce(digest)

    const jsx = await DashboardPage()
    render(jsx)

    expect(screen.getByText("Classified")).toBeInTheDocument()
    expect(screen.getByText("High Priority")).toBeInTheDocument()
    expect(screen.queryByText(/no digest yet/i)).not.toBeInTheDocument()
  })
})
