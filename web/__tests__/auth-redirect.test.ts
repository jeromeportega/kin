import { describe, it, expect, vi } from "vitest"

// Mocks are hoisted — prevent next-auth and next/server from loading transitively
vi.mock("@/auth", () => ({
  auth: vi.fn((callback: any) => (req: any) => callback(req)),
  handlers: { GET: vi.fn(), POST: vi.fn() },
  signIn: vi.fn(),
  signOut: vi.fn(),
}))

vi.mock("next/server", () => ({
  NextResponse: {
    redirect: (url: URL | string) => {
      const location = url.toString()
      return new Response(null, { status: 307, headers: { location } })
    },
  },
}))

// auth.config.ts has no next-auth dependency — safe to import directly
import { GOOGLE_SCOPE, SESSION_STRATEGY } from "@/auth.config"
import { guardDashboard } from "@/middleware"

// ─── Google provider scope ───────────────────────────────────────────────────

describe("Google auth scope", () => {
  it("scope is exactly openid email profile", () => {
    expect(GOOGLE_SCOPE).toBe("openid email profile")
  })

  it("scope does not contain gmail.readonly", () => {
    expect(GOOGLE_SCOPE).not.toContain("gmail.readonly")
  })
})

// ─── Session configuration ───────────────────────────────────────────────────

describe("session config", () => {
  it("session.strategy is jwt (encrypted cookie)", () => {
    expect(SESSION_STRATEGY).toBe("jwt")
  })
})

// ─── Dashboard route guard ───────────────────────────────────────────────────

describe("guardDashboard", () => {
  it("redirects to /signin when unauthenticated (auth returns null)", () => {
    const response = guardDashboard(null, "http://localhost:3000")
    expect(response).toBeDefined()
    expect((response as Response).status).toBe(307)
    const location = (response as Response).headers.get("location")
    expect(location).toBe("http://localhost:3000/signin")
  })

  it("does not redirect when authenticated (auth returns a session)", () => {
    const session = {
      user: { name: "Test User", email: "test@example.com", image: null },
      expires: "2099-12-31T00:00:00.000Z",
    }
    const response = guardDashboard(session as any, "http://localhost:3000")
    expect(response).toBeUndefined()
  })
})
