import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("server-only", () => ({}))

const mockRevalidatePath = vi.hoisted(() => vi.fn())
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }))

const mockAuth = vi.hoisted(() => vi.fn())
vi.mock("@/auth", () => ({ auth: mockAuth }))

const mockSpawnIngestion = vi.hoisted(() => vi.fn<[string], Promise<number>>())
vi.mock("@/lib/spawnIngestion", () => ({ spawnIngestion: mockSpawnIngestion }))

import { POST } from "@/app/api/sync/route"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("POST /api/sync", () => {
  // ─── AC1: no session → 401, spawn not called ──────────────────────────────

  it("returns 401 and does not spawn when auth() returns null", async () => {
    mockAuth.mockResolvedValueOnce(null)

    const res = await POST()

    expect(res.status).toBe(401)
    expect(mockSpawnIngestion).not.toHaveBeenCalled()
  })

  // ─── AC2 happy path: EXIT_OK → 200 + revalidatePath ──────────────────────

  it("returns 200 {ok:true} and revalidates /dashboard on EXIT_OK (0)", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } })
    mockSpawnIngestion.mockResolvedValueOnce(0)

    const res = await POST()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(mockRevalidatePath).toHaveBeenCalledOnce()
    expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard")
  })

  it("spawns with session.user.email as --user argument", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } })
    mockSpawnIngestion.mockResolvedValueOnce(0)

    await POST()

    expect(mockSpawnIngestion).toHaveBeenCalledWith("user@example.com")
  })

  // ─── AC3: EXIT_REAUTH → 409 {reauth:true} ─────────────────────────────────

  it("returns 409 {reauth:true} on EXIT_REAUTH (2)", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } })
    mockSpawnIngestion.mockResolvedValueOnce(2)

    const res = await POST()

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ reauth: true })
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  // ─── error: other non-zero → 500 {ok:false} ───────────────────────────────

  it("returns 500 {ok:false} on other non-zero exit codes", async () => {
    for (const code of [1, 3, 4, 5]) {
      vi.clearAllMocks()
      mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } })
      mockSpawnIngestion.mockResolvedValueOnce(code)

      const res = await POST()

      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ ok: false })
      expect(mockRevalidatePath).not.toHaveBeenCalled()
    }
  })

  // ─── AC1/S1 identity — critical ───────────────────────────────────────────

  it("[S1] invokes ingestion with session email, not any client-supplied email", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "session@example.com" } })
    mockSpawnIngestion.mockResolvedValueOnce(0)

    await POST()

    expect(mockSpawnIngestion).toHaveBeenCalledWith("session@example.com")
    expect(mockSpawnIngestion).not.toHaveBeenCalledWith("attacker@example.com")
  })

  // ─── method guard / CSRF ──────────────────────────────────────────────────

  it("only exports POST (GET is not exported)", async () => {
    const mod = await import("@/app/api/sync/route")
    expect(mod.POST).toBeTypeOf("function")
    expect((mod as Record<string, unknown>).GET).toBeUndefined()
  })

  // ─── AC2 read-back: 200 triggers revalidatePath ───────────────────────────

  it("does not call revalidatePath on failed sync (non-zero exit)", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } })
    mockSpawnIngestion.mockResolvedValueOnce(1)

    await POST()

    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  // ─── 401 structured body ─────────────────────────────────────────────────

  it("returns a JSON error body on 401", async () => {
    mockAuth.mockResolvedValueOnce(null)

    const res = await POST()

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toHaveProperty("error")
  })

  // ─── concurrency guard: 429 when same user already in flight ─────────────

  it("returns 429 when a sync is already in progress for the same user", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } })
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } })

    let resolveFirst!: (code: number) => void
    mockSpawnIngestion.mockReturnValueOnce(new Promise<number>((r) => { resolveFirst = r }))

    // Start first sync; it will be suspended at await spawnIngestion()
    const firstPromise = POST()
    // Flush one microtask so the first POST advances past inFlight.add()
    await Promise.resolve()

    const secondResponse = await POST()
    expect(secondResponse.status).toBe(429)
    const body = await secondResponse.json()
    expect(body).toHaveProperty("error")

    // Clean up: resolve the first sync
    resolveFirst(0)
    await firstPromise
  })
})
