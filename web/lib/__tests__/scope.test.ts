import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/auth", () => ({
  auth: vi.fn(),
}))

import { auth } from "@/auth"
import { resolveScope } from "@/lib/scope"

const DEMO_USER = "jerome"

beforeEach(() => {
  process.env.KIN_DEMO_USER = DEMO_USER
})

afterEach(() => {
  vi.resetAllMocks()
  delete process.env.KIN_DEMO_USER
})

describe("resolveScope", () => {
  it("returns KIN_DEMO_USER when session exists", async () => {
    vi.mocked(auth).mockResolvedValueOnce({ user: { email: "user@example.com" } } as never)

    const result = await resolveScope()

    expect(result).toBe(DEMO_USER)
  })

  it("throws Unauthenticated when auth() returns null", async () => {
    vi.mocked(auth).mockResolvedValueOnce(null as never)

    await expect(resolveScope()).rejects.toThrow("Unauthenticated")
  })

  it("throws when KIN_DEMO_USER is unset", async () => {
    delete process.env.KIN_DEMO_USER
    vi.mocked(auth).mockResolvedValueOnce({ user: { email: "user@example.com" } } as never)

    await expect(resolveScope()).rejects.toThrow("KIN_DEMO_USER is not configured")
  })
})
