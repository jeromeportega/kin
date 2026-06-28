import { describe, it, expect, vi } from "vitest"

// Mocks are hoisted — prevent next-auth and next/server from loading transitively.
// middleware.ts builds its OWN edge-safe NextAuth instance (it must not import
// "@/auth", which pulls in the Node-only token store), so we mock next-auth here.
vi.mock("next-auth", () => ({
  default: vi.fn(() => ({
    auth: vi.fn((callback: any) => (req: any) => callback(req)),
    handlers: { GET: vi.fn(), POST: vi.fn() },
    signIn: vi.fn(),
    signOut: vi.fn(),
  })),
}))

vi.mock("next-auth/providers/google", () => ({
  default: vi.fn(() => ({ id: "google" })),
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
import { guardDashboard } from "@/proxy"

// ─── Google provider scope ───────────────────────────────────────────────────

describe("Google auth scope", () => {
  it("GOOGLE_SCOPE equals exactly the required value", () => {
    expect(GOOGLE_SCOPE).toBe(
      "openid email profile https://www.googleapis.com/auth/gmail.readonly"
    )
  })

  it("scope includes gmail.readonly", () => {
    expect(GOOGLE_SCOPE).toContain("https://www.googleapis.com/auth/gmail.readonly")
  })

  it("scope does not include gmail.modify, gmail.send, gmail.compose, or full mail access", () => {
    expect(GOOGLE_SCOPE).not.toContain("gmail.modify")
    expect(GOOGLE_SCOPE).not.toContain("gmail.send")
    expect(GOOGLE_SCOPE).not.toContain("gmail.compose")
    expect(GOOGLE_SCOPE).not.toContain("https://mail.google.com/")
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
    const response = guardDashboard(null, "https://app.example.com")
    expect(response).toBeDefined()
    expect((response as Response).status).toBe(307)
    const location = (response as Response).headers.get("location")
    expect(location).toContain("/signin")
    expect(location).toContain("app.example.com") // redirect uses the request origin
  })

  it("does not redirect when authenticated (auth returns a session)", () => {
    const session = {
      user: { name: "Test User", email: "test@example.com", image: null },
      expires: "2099-12-31T00:00:00.000Z",
    }
    const response = guardDashboard(session as any, "https://app.example.com")
    expect(response).toBeUndefined()
  })

})
