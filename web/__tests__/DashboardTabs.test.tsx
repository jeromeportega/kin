import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"

// DigestItemCard renders MuteButton, which calls useRouter — stub the app router.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { DashboardTabs } from "@/components/DashboardTabs"
import type { Classification, Digest } from "@/lib/types"

function classification(over: Partial<Classification>): Classification {
  return {
    classification_id: 1,
    model: "claude-sonnet-4-6",
    prompt_version: "abc",
    category: "finance",
    priority: "low",
    action_required: false,
    summary: "A summary",
    action_items: [],
    dates: [],
    links: [],
    events: [],
    confidence: 0.9,
    classified_at: "2026-06-26T12:00:00+00:00",
    email_id: 1,
    message_id: "<a@x>",
    uid: "1",
    folder: "INBOX",
    from_addr: "sender@example.com",
    subject: "Subject A",
    email_date: "2026-06-26T10:00:00+00:00",
    ...over,
  }
}

const digest: Digest = {
  generated_at: "2026-06-26T12:00:00+00:00",
  user_id: "u@example.com",
  model: null,
  prompt_version: null,
  window_hours: 24,
  window_start: "2026-06-25T12:00:00+00:00",
  window_end: "2026-06-26T12:00:00+00:00",
  include_other: false,
  classified_count: 1,
  actionable_count: 1,
  informational_count: 0,
  skipped_other_count: 0,
  dropped_low_count: 0,
  items: [
    {
      classification_id: 99,
      message_id: "<d@x>",
      uid: "9",
      from_addr: "daycare@school.example",
      subject: "Digest-only subject",
      date: "2026-06-26T09:00:00+00:00",
      category: "daycare",
      priority: "high",
      action_required: true,
      summary: "Pickup change",
      action_items: ["Pick up early"],
      dates: ["2026-06-27"],
      links: [],
      events: [],
      confidence: 0.95,
      model: "claude-sonnet-4-6",
      prompt_version: "abc",
      classified_at: "2026-06-26T12:00:00+00:00",
    },
  ],
}

const classifications: Classification[] = [
  classification({ classification_id: 1, priority: "high", subject: "High one" }),
  classification({ classification_id: 2, priority: "high", subject: "High two" }),
  classification({ classification_id: 3, priority: "medium", subject: "Medium one" }),
  classification({ classification_id: 4, priority: "low", subject: "Low one" }),
]

describe("DashboardTabs", () => {
  it("renders all four tabs with per-priority counts", () => {
    render(<DashboardTabs digest={digest} classifications={classifications} />)
    expect(screen.getByRole("tab", { name: "Digest" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "High (2)" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Medium (1)" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Low (1)" })).toBeInTheDocument()
  })

  it("shows the curated digest on the default tab", () => {
    render(<DashboardTabs digest={digest} classifications={classifications} />)
    expect(screen.getByText("Digest-only subject")).toBeInTheDocument()
  })

  it("shows a priority's classifications when its tab is selected", () => {
    render(<DashboardTabs digest={digest} classifications={classifications} />)
    fireEvent.click(screen.getByRole("tab", { name: "High (2)" }))
    expect(screen.getByText("High one")).toBeInTheDocument()
    expect(screen.getByText("High two")).toBeInTheDocument()
  })

  it("renders an empty state for the digest tab when there is no digest", () => {
    render(<DashboardTabs digest={null} classifications={[]} />)
    expect(screen.getByRole("tab", { name: "High (0)" })).toBeInTheDocument()
    expect(screen.getByText(/No digest yet/i)).toBeInTheDocument()
  })
})
