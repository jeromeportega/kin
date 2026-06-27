import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/auth", () => ({
  auth: vi.fn(),
}))

import { auth } from "@/auth"
import { resolveScope } from "@/lib/scope"

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  vi.resetAllMocks()
})

describe("resolveScope", () => {
  it("returns session.user.email when session exists", async () => {
    vi.mocked(auth).mockResolvedValueOnce({ user: { email: "user@example.com" } } as never)

    const result = await resolveScope()

    expect(result).toBe("user@example.com")
  })

  it("throws 'no active session' when auth() returns null", async () => {
    vi.mocked(auth).mockResolvedValueOnce(null as never)

    await expect(resolveScope()).rejects.toThrow("no active session")
  })

  it("throws 'session has no email' when session exists but lacks email", async () => {
    vi.mocked(auth).mockResolvedValueOnce({ user: {} } as never)

    await expect(resolveScope()).rejects.toThrow("session has no email")
  })

  it("uses session email not KIN_DEMO_USER (ADR-010)", async () => {
    process.env.KIN_DEMO_USER = "demo-user"
    vi.mocked(auth).mockResolvedValueOnce({ user: { email: "real@example.com" } } as never)

    const result = await resolveScope()

    expect(result).toBe("real@example.com")
    expect(result).not.toBe("demo-user")
    delete process.env.KIN_DEMO_USER
  })
})
