import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Mock server-only so tests can import api.ts outside Next.js server context
vi.mock("server-only", () => ({}))

// Set required env vars before importing the module
const BASE_URL = "http://127.0.0.1:8000"
const DEMO_USER = "jerome"

beforeEach(() => {
  process.env.KIN_API_BASE_URL = BASE_URL
  process.env.KIN_DEMO_USER = DEMO_USER
  vi.stubGlobal("fetch", vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.KIN_API_BASE_URL
  delete process.env.KIN_DEMO_USER
})

import { fetchDigest, fetchClassifications } from "@/lib/api"
import type { Digest, Classification } from "@/lib/types"

// ─── fetchDigest ──────────────────────────────────────────────────────────────

describe("fetchDigest", () => {
  const makeDigest = (overrides: Partial<Digest> = {}): Digest => ({
    generated_at: "2024-01-01T00:00:00Z",
    user_id: DEMO_USER,
    model: "gpt-4",
    prompt_version: "v1",
    window_hours: 24,
    window_start: "2023-12-31T00:00:00Z",
    window_end: "2024-01-01T00:00:00Z",
    include_other: false,
    classified_count: 1,
    actionable_count: 1,
    informational_count: 0,
    skipped_other_count: 0,
    dropped_low_count: 0,
    items: [
      {
        classification_id: 1,
        message_id: "msg-1",
        uid: null,
        from_addr: "sender@example.com",
        subject: "Test",
        date: "2024-01-01T00:00:00Z",
        category: "work",
        priority: "high",
        action_required: true,
        summary: "A test email",
        action_items: ["Reply"],
        dates: [],
        confidence: 0.9,
        model: "gpt-4",
        prompt_version: "v1",
        classified_at: "2024-01-01T00:00:00Z",
      },
    ],
    ...overrides,
  })

  it("sends ?user_id= set to KIN_DEMO_USER scope param", async () => {
    const digest = makeDigest()
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(digest), { status: 200 })
    )

    await fetchDigest(DEMO_USER)

    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
    expect(calledUrl).toBe(`${BASE_URL}/api/digest/latest?user_id=${DEMO_USER}`)
  })

  it("URL encodes the user_id scope param", async () => {
    const digest = makeDigest()
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(digest), { status: 200 })
    )

    await fetchDigest("jerome+test")

    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
    expect(calledUrl).toContain("user_id=jerome%2Btest")
  })

  it("returns null when API responds 204 (empty-state signal)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }))

    const result = await fetchDigest(DEMO_USER)

    expect(result).toBeNull()
  })

  it("returns null when payload has no items (zeroed payload)", async () => {
    const emptyDigest = makeDigest({ items: [], classified_count: 0 })
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(emptyDigest), { status: 200 })
    )

    const result = await fetchDigest(DEMO_USER)

    expect(result).toBeNull()
  })

  it("returns typed Digest when API responds 200 with populated payload", async () => {
    const digest = makeDigest()
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(digest), { status: 200 })
    )

    const result = await fetchDigest(DEMO_USER)

    expect(result).not.toBeNull()
    expect(result?.user_id).toBe(DEMO_USER)
    expect(result?.items).toHaveLength(1)
    expect(result?.items[0].classification_id).toBe(1)
  })

  it("throws on non-ok, non-204 HTTP responses", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 500 }))

    await expect(fetchDigest(DEMO_USER)).rejects.toThrow("fetchDigest failed: 500")
  })

  it("constructs URL from KIN_API_BASE_URL", async () => {
    const digest = makeDigest()
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(digest), { status: 200 })
    )

    await fetchDigest(DEMO_USER)

    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
    expect(calledUrl.startsWith(BASE_URL)).toBe(true)
  })

  it("passes cache: no-store to prevent stale digest across users", async () => {
    const digest = makeDigest()
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(digest), { status: 200 })
    )

    await fetchDigest(DEMO_USER)

    const calledOptions = vi.mocked(fetch).mock.calls[0][1] as RequestInit
    expect(calledOptions?.cache).toBe("no-store")
  })

  it("creates a fresh AbortSignal per call", async () => {
    const digest = makeDigest()
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(digest), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(digest), { status: 200 }))

    await fetchDigest(DEMO_USER)
    await fetchDigest(DEMO_USER)

    const signal1 = (vi.mocked(fetch).mock.calls[0][1] as RequestInit)?.signal
    const signal2 = (vi.mocked(fetch).mock.calls[1][1] as RequestInit)?.signal
    expect(signal1).toBeInstanceOf(AbortSignal)
    expect(signal2).toBeInstanceOf(AbortSignal)
    expect(signal1).not.toBe(signal2)
  })

  it("throws when userId is empty", async () => {
    await expect(fetchDigest("")).rejects.toThrow("userId is required")
  })
})

// ─── fetchClassifications ─────────────────────────────────────────────────────

describe("fetchClassifications", () => {
  const makeClassification = (): Classification => ({
    classification_id: 1,
    model: "gpt-4",
    prompt_version: "v1",
    category: "work",
    priority: "high",
    action_required: true,
    summary: "Classify this",
    action_items: [],
    dates: [],
    confidence: 0.95,
    classified_at: "2024-01-01T00:00:00Z",
    email_id: 42,
    message_id: "msg-1",
    uid: null,
    folder: "INBOX",
    from_addr: "sender@example.com",
    subject: "Hello",
    email_date: "2024-01-01T00:00:00Z",
  })

  it("sends user_id and hours params to /api/classifications", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify([makeClassification()]), { status: 200 })
    )

    await fetchClassifications(DEMO_USER, 48)

    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
    expect(calledUrl).toBe(
      `${BASE_URL}/api/classifications?user_id=${DEMO_USER}&hours=48`
    )
  })

  it("sends ?user_id= set to KIN_DEMO_USER scope param", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify([]), { status: 200 })
    )

    await fetchClassifications(DEMO_USER, 24)

    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
    const parsed = new URL(calledUrl)
    expect(parsed.searchParams.get("user_id")).toBe(DEMO_USER)
  })

  it("returns typed Classification[] on 200", async () => {
    const cls = makeClassification()
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify([cls]), { status: 200 })
    )

    const result = await fetchClassifications(DEMO_USER, 24)

    expect(result).toHaveLength(1)
    expect(result[0].classification_id).toBe(1)
    expect(result[0].from_addr).toBe("sender@example.com")
  })

  it("returns empty array when no classifications", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify([]), { status: 200 })
    )

    const result = await fetchClassifications(DEMO_USER, 24)

    expect(result).toEqual([])
  })

  it("throws on non-ok HTTP responses", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 500 }))

    await expect(fetchClassifications(DEMO_USER, 24)).rejects.toThrow(
      "fetchClassifications failed: 500"
    )
  })

  it("rejects negative hours", async () => {
    await expect(fetchClassifications(DEMO_USER, -1)).rejects.toThrow(
      "hours must be a positive integer"
    )
  })

  it("rejects zero hours", async () => {
    await expect(fetchClassifications(DEMO_USER, 0)).rejects.toThrow(
      "hours must be a positive integer"
    )
  })

  it("rejects fractional hours", async () => {
    await expect(fetchClassifications(DEMO_USER, 1.5)).rejects.toThrow(
      "hours must be a positive integer"
    )
  })

  it("passes cache: no-store to prevent stale classifications across users", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify([]), { status: 200 })
    )

    await fetchClassifications(DEMO_USER, 24)

    const calledOptions = vi.mocked(fetch).mock.calls[0][1] as RequestInit
    expect(calledOptions?.cache).toBe("no-store")
  })

  it("creates a fresh AbortSignal per call", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))

    await fetchClassifications(DEMO_USER, 24)
    await fetchClassifications(DEMO_USER, 24)

    const signal1 = (vi.mocked(fetch).mock.calls[0][1] as RequestInit)?.signal
    const signal2 = (vi.mocked(fetch).mock.calls[1][1] as RequestInit)?.signal
    expect(signal1).toBeInstanceOf(AbortSignal)
    expect(signal2).toBeInstanceOf(AbortSignal)
    expect(signal1).not.toBe(signal2)
  })

  it("throws when userId is empty", async () => {
    await expect(fetchClassifications("", 24)).rejects.toThrow("userId is required")
  })
})
