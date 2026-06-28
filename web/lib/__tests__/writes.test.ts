import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("server-only", () => ({}))

const execute = vi.fn()
vi.mock("@/lib/db", () => ({ dbClient: () => ({ execute }) }))

import {
  upsertEmail,
  findClassification,
  insertClassification,
  insertClassificationError,
  startRun,
  finishRun,
} from "@/lib/writes"

beforeEach(() => execute.mockReset())

const msg = {
  message_id: "<a@x>",
  uid: "1",
  from_addr: "a@x.com",
  subject: "Hi",
  date: "2026-01-01T00:00:00+00:00",
  text_body: "body",
  truncated: false,
}
const result = {
  category: "finance" as const,
  priority: "high" as const,
  action_required: true,
  summary: "s",
  action_items: ["pay"],
  dates: ["2026-06-01"],
  confidence: 0.9,
}

describe("upsertEmail", () => {
  it("upserts and returns the id", async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: 42 }] })
    const id = await upsertEmail({ userId: "u", folder: "INBOX", msg, now: "2026-01-02T00:00:00+00:00" })
    expect(id).toBe(42)
    const a = execute.mock.calls[0][0]
    expect(a.sql).toContain("ON CONFLICT")
    expect(a.sql).toContain("RETURNING id")
    expect(a.args).toContain("a@x.com")
    expect(a.args).toContain(0) // truncated false → 0
  })
})

describe("findClassification", () => {
  it("returns null when there is no row", async () => {
    execute.mockResolvedValueOnce({ rows: [] })
    expect(await findClassification({ emailId: 1, model: "m", promptVersion: "v" })).toBeNull()
  })
  it("parses a found row", async () => {
    execute.mockResolvedValueOnce({
      rows: [
        {
          category: "finance",
          priority: "high",
          action_required: 1,
          summary: "s",
          action_items: '["pay"]',
          dates: "[]",
          confidence: 0.9,
        },
      ],
    })
    const c = await findClassification({ emailId: 1, model: "m", promptVersion: "v" })
    expect(c?.action_required).toBe(true)
    expect(c?.action_items).toEqual(["pay"])
  })
})

describe("insertClassification", () => {
  it("inserts and returns lastInsertRowid", async () => {
    execute.mockResolvedValueOnce({ lastInsertRowid: BigInt(7) })
    const id = await insertClassification({
      emailId: 1,
      runId: 2,
      model: "m",
      promptVersion: "v",
      result,
      truncated: false,
      now: "t",
    })
    expect(id).toBe(7)
    const a = execute.mock.calls[0][0]
    expect(a.args).toContain("finance")
    expect(a.args).toContain(1) // action_required true → 1
    expect(a.args).toContain('["pay"]') // action_items JSON
  })
})

describe("insertClassificationError", () => {
  it("inserts an error row", async () => {
    execute.mockResolvedValueOnce({ lastInsertRowid: BigInt(8) })
    const id = await insertClassificationError({
      emailId: 1,
      runId: null,
      model: "m",
      promptVersion: "v",
      error: "boom",
      truncated: true,
      now: "t",
    })
    expect(id).toBe(8)
    const a = execute.mock.calls[0][0]
    expect(a.args).toContain("boom")
    expect(a.args).toContain(1) // truncated true
  })
})

describe("startRun / finishRun", () => {
  it("startRun inserts and returns the id", async () => {
    execute.mockResolvedValueOnce({ lastInsertRowid: BigInt(3) })
    const id = await startRun({
      userId: "u",
      args: { a: 1 },
      model: "m",
      promptVersion: "v",
      hours: 24,
      limitN: 50,
      now: "t",
    })
    expect(id).toBe(3)
  })
  it("finishRun updates the run", async () => {
    execute.mockResolvedValueOnce({})
    await finishRun({
      runId: 3,
      fetched: 5,
      filtered: 2,
      classified: 1,
      reused: 1,
      errors: 0,
      truncated: 0,
      now: "t",
    })
    const a = execute.mock.calls[0][0]
    expect(a.sql).toContain("UPDATE runs SET")
    expect(a.args).toContain(3) // runId
  })
})
