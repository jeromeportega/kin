import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("server-only", () => ({}))

const h = vi.hoisted(() => ({ execute: vi.fn(), runIngest: vi.fn() }))
vi.mock("@/lib/db", () => ({ dbClient: () => ({ execute: h.execute }) }))
vi.mock("@/lib/ingest", () => ({ runIngest: h.runIngest }))

import { GET } from "@/app/api/cron/route"

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.CRON_SECRET
})

const req = (auth?: string) =>
  new Request("http://x/api/cron", { headers: auth ? { authorization: auth } : {} })

describe("GET /api/cron", () => {
  it("runs ingest for each user with a stored token", async () => {
    h.execute.mockResolvedValueOnce({ rows: [{ email: "a@x.com" }, { email: "b@y.com" }] })
    h.runIngest.mockResolvedValue({ fetched: 1, filtered: 1, classified: 1, reused: 0, errors: 0 })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(h.runIngest).toHaveBeenCalledTimes(2)
    expect(h.runIngest).toHaveBeenCalledWith("a@x.com")
  })

  it("rejects without the correct CRON_SECRET", async () => {
    process.env.CRON_SECRET = "s3cret"
    const res = await GET(req("Bearer wrong"))
    expect(res.status).toBe(401)
    expect(h.runIngest).not.toHaveBeenCalled()
  })

  it("accepts with the correct CRON_SECRET", async () => {
    process.env.CRON_SECRET = "s3cret"
    h.execute.mockResolvedValueOnce({ rows: [] })
    expect((await GET(req("Bearer s3cret"))).status).toBe(200)
  })

  it("records a per-user error without failing the run", async () => {
    h.execute.mockResolvedValueOnce({ rows: [{ email: "a@x.com" }] })
    h.runIngest.mockRejectedValueOnce(new Error("boom"))
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results[0].error).toContain("boom")
  })
})
