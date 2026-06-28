import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("server-only", () => ({}))

const mockRevalidatePath = vi.hoisted(() => vi.fn())
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }))

const mockAuth = vi.hoisted(() => vi.fn())
vi.mock("@/auth", () => ({ auth: mockAuth }))

const mockRunIngest = vi.hoisted(() => vi.fn())
vi.mock("@/lib/ingest", () => ({ runIngest: mockRunIngest }))

// The route does `instanceof ReauthRequired`, so use the real class (gmail.ts has
// no side effects beyond importing the mocked server-only).
import { ReauthRequired } from "@/lib/gmail"
import { POST } from "@/app/api/sync/route"

beforeEach(() => vi.clearAllMocks())

const flushMicrotasks = () => new Promise<void>((r) => setImmediate(r))
const RESULT = { fetched: 3, filtered: 2, classified: 1, reused: 1, errors: 0 }

describe("POST /api/sync", () => {
  it("returns 401 and does not ingest when auth() is null", async () => {
    mockAuth.mockResolvedValueOnce(null)
    const res = await POST()
    expect(res.status).toBe(401)
    expect(mockRunIngest).not.toHaveBeenCalled()
  })

  it("returns 401 when the session has no email", async () => {
    mockAuth.mockResolvedValueOnce({ user: {} })
    const res = await POST()
    expect(res.status).toBe(401)
    expect(mockRunIngest).not.toHaveBeenCalled()
  })

  it("returns 200 with the result and revalidates on success", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } })
    mockRunIngest.mockResolvedValueOnce(RESULT)
    const res = await POST()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, ...RESULT })
    expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard")
  })

  it("[S1] ingests with the session email, never a client-supplied one", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "session@example.com" } })
    mockRunIngest.mockResolvedValueOnce(RESULT)
    await POST()
    expect(mockRunIngest).toHaveBeenCalledWith("session@example.com")
    expect(mockRunIngest).not.toHaveBeenCalledWith("attacker@example.com")
  })

  it("returns 409 {reauth:true} when runIngest throws ReauthRequired", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } })
    mockRunIngest.mockRejectedValueOnce(new ReauthRequired("revoked"))
    const res = await POST()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ reauth: true })
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  it("returns 500 {ok:false} on a generic error", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } })
    mockRunIngest.mockRejectedValueOnce(new Error("boom"))
    const res = await POST()
    expect(res.status).toBe(500)
    expect((await res.json()).ok).toBe(false)
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  it("returns 429 when a sync is already in progress for the same user", async () => {
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } })
    mockAuth.mockResolvedValueOnce({ user: { email: "user@example.com" } })

    let resolveFirst!: (r: unknown) => void
    mockRunIngest.mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))

    const first = POST()
    await flushMicrotasks()
    const second = await POST()
    expect(second.status).toBe(429)

    resolveFirst(RESULT)
    await first
  })

  it("only exports POST (no GET)", async () => {
    const mod = await import("@/app/api/sync/route")
    expect(mod.POST).toBeTypeOf("function")
    expect((mod as Record<string, unknown>).GET).toBeUndefined()
  })
})
