import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("server-only", () => ({}))

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  muteSender: vi.fn(),
  unmuteSender: vi.fn(),
  revalidatePath: vi.fn(),
}))
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }))
vi.mock("@/auth", () => ({ auth: h.auth }))
vi.mock("@/lib/kinConfig", () => ({ muteSender: h.muteSender, unmuteSender: h.unmuteSender }))

import { POST } from "@/app/api/mute/route"

const req = (body: unknown) =>
  new Request("http://x/api/mute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.auth.mockResolvedValue({ user: { email: "user@example.com" } })
})

describe("POST /api/mute", () => {
  it("401s when unauthenticated", async () => {
    h.auth.mockResolvedValueOnce(null)
    const res = await POST(req({ sender: "a@x.com" }))
    expect(res.status).toBe(401)
    expect(h.muteSender).not.toHaveBeenCalled()
  })

  it("400s when sender is missing", async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
  })

  it("mutes the sender for the session user and revalidates", async () => {
    const res = await POST(req({ sender: "Spam <spam@x.com>" }))
    expect(res.status).toBe(200)
    expect(h.muteSender).toHaveBeenCalledWith("user@example.com", "Spam <spam@x.com>")
    expect(h.unmuteSender).not.toHaveBeenCalled()
    expect(h.revalidatePath).toHaveBeenCalledWith("/dashboard")
  })

  it("unmutes when unmute:true", async () => {
    const res = await POST(req({ sender: "spam@x.com", unmute: true }))
    expect(res.status).toBe(200)
    expect(h.unmuteSender).toHaveBeenCalledWith("user@example.com", "spam@x.com")
    expect(h.muteSender).not.toHaveBeenCalled()
  })

  it("[scope] mutes for the session user, never a client-supplied one", async () => {
    await POST(req({ sender: "a@x.com", userId: "attacker@example.com" }))
    expect(h.muteSender).toHaveBeenCalledWith("user@example.com", "a@x.com")
  })
})
