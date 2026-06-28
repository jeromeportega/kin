import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("server-only", () => ({}))

const execute = vi.fn()
vi.mock("@/lib/db", () => ({ dbClient: () => ({ execute }) }))

import { readKinConfig, applyTuning } from "@/lib/kinConfig"
import { writeRefreshToken, readRefreshToken } from "@/lib/tokenStore"

beforeEach(() => {
  execute.mockReset()
})

describe("kinConfig over Turso", () => {
  it("reads filter_entries grouped by kind, scoped to the user", async () => {
    execute.mockResolvedValueOnce({
      rows: [
        { kind: "sender_allowlist", value: "a@x.com" },
        { kind: "subject_keywords", value: "bill" },
      ],
    })
    const cfg = await readKinConfig("jerome")
    expect(cfg.sender_allowlist).toEqual(["a@x.com"])
    expect(cfg.subject_keywords).toEqual(["bill"])
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ args: ["jerome"] }))
  })

  it("applyTuning inserts lowercased entries and counts new rows", async () => {
    execute.mockResolvedValue({ rowsAffected: 1 })
    const added = await applyTuning({ allow: ["A@X.com"], keyword: ["Bill"] }, "jerome")
    expect(added.sender_allowlist).toBe(1)
    expect(added.subject_keywords).toBe(1)
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["jerome", "sender_allowlist", "a@x.com"] })
    )
  })
})

describe("tokenStore over Turso", () => {
  it("writes via upsert", async () => {
    execute.mockResolvedValue({ rows: [] })
    await writeRefreshToken("me@x.com", "tok")
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ args: expect.arrayContaining(["me@x.com", "tok"]) })
    )
  })

  it("reads the refresh token", async () => {
    execute.mockResolvedValueOnce({ rows: [{ refresh_token: "tok" }] })
    expect(await readRefreshToken("me@x.com")).toBe("tok")
  })

  it("returns null when there is no row", async () => {
    execute.mockResolvedValueOnce({ rows: [] })
    expect(await readRefreshToken("me@x.com")).toBeNull()
  })
})
