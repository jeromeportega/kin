import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest"

// vi.hoisted ensures these are created before mock factories execute
const mockWriteRefreshToken = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const capturedCallbacks = vi.hoisted(() => ({ current: null as any }))

vi.mock("@/lib/tokenStore", () => ({
  writeRefreshToken: mockWriteRefreshToken,
}))

vi.mock("next-auth/providers/google", () => ({
  default: vi.fn().mockReturnValue({ id: "google", name: "Google" }),
}))

vi.mock("next-auth", () => ({
  default: vi.fn().mockImplementation((config: any) => {
    capturedCallbacks.current = config.callbacks
    return {
      handlers: { GET: vi.fn(), POST: vi.fn() },
      auth: vi.fn(),
      signIn: vi.fn(),
      signOut: vi.fn(),
    }
  }),
}))

describe("auth.ts callbacks", () => {
  beforeAll(async () => {
    process.env.AUTH_SECRET = "test-secret"
    process.env.GOOGLE_CLIENT_ID = "test-client-id"
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret"
    // Dynamic import after env vars are set — auth.ts guards at module load time
    await import("@/auth")
  })

  afterAll(() => {
    delete process.env.AUTH_SECRET
    delete process.env.GOOGLE_CLIENT_ID
    delete process.env.GOOGLE_CLIENT_SECRET
    vi.resetModules()
  })

  afterEach(() => {
    mockWriteRefreshToken.mockClear()
  })

  // ─── jwt callback ──────────────────────────────────────────────────────────

  describe("jwt callback", () => {
    it("calls writeRefreshToken with email and refresh_token on first sign-in", async () => {
      const token = { email: "user@example.com", sub: "123" }
      const account = { refresh_token: "rt_abc123", provider: "google" }

      const result = await capturedCallbacks.current.jwt({ token, account })

      expect(mockWriteRefreshToken).toHaveBeenCalledOnce()
      expect(mockWriteRefreshToken).toHaveBeenCalledWith("user@example.com", "rt_abc123")
      expect(result).toEqual(token)
    })

    it("returns token unchanged when account is null (subsequent sessions)", async () => {
      const token = { email: "user@example.com", sub: "123" }

      const result = await capturedCallbacks.current.jwt({ token, account: null })

      expect(mockWriteRefreshToken).not.toHaveBeenCalled()
      expect(result).toEqual(token)
    })

    it("returns token unchanged when account is undefined", async () => {
      const token = { email: "user@example.com", sub: "123" }

      const result = await capturedCallbacks.current.jwt({ token, account: undefined })

      expect(mockWriteRefreshToken).not.toHaveBeenCalled()
      expect(result).toEqual(token)
    })

    it("does not call writeRefreshToken when account has no refresh_token", async () => {
      const token = { email: "user@example.com", sub: "123" }
      const account = { provider: "google", access_token: "at_xyz" }

      const result = await capturedCallbacks.current.jwt({ token, account })

      expect(mockWriteRefreshToken).not.toHaveBeenCalled()
      expect(result).toEqual(token)
    })
  })

  // ─── session callback ──────────────────────────────────────────────────────

  describe("session callback", () => {
    it("does not expose refresh_token anywhere in the returned session", async () => {
      const session = {
        user: { name: "Test User", email: "user@example.com", image: null },
        expires: "2099-12-31T00:00:00.000Z",
      }
      const token = {
        email: "user@example.com",
        sub: "123",
        refresh_token: "rt_must_not_leak",
      }

      const result = await capturedCallbacks.current.session({ session, token })

      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain("refresh_token")
      expect(serialized).not.toContain("rt_must_not_leak")
    })

    it("returns the session object as-is", async () => {
      const session = {
        user: { name: "Test User", email: "user@example.com", image: null },
        expires: "2099-12-31T00:00:00.000Z",
      }

      const result = await capturedCallbacks.current.session({ session, token: {} })

      expect(result).toEqual(session)
    })
  })
})
