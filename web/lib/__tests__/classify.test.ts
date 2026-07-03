import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("server-only", () => ({}))

const parse = vi.fn()
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { parse }
  },
}))
vi.mock("@anthropic-ai/sdk/helpers/zod", () => ({
  zodOutputFormat: (schema: unknown) => ({ __format: schema }),
}))

import { classify, MODEL, PROMPT_VERSION } from "@/lib/classify"

beforeEach(() => {
  parse.mockReset()
})

const RESULT = {
  category: "finance",
  priority: "high",
  action_required: true,
  summary: "A bill",
  action_items: ["Pay $10"],
  dates: ["2026-06-01"],
  confidence: 0.9,
}

describe("classify", () => {
  it("calls messages.parse with the cached system block + email user turn", async () => {
    parse.mockResolvedValueOnce({ parsed_output: RESULT, stop_reason: "end_turn" })

    const out = await classify("Subject: bill\n\nPay up")
    expect(out).toEqual(RESULT)

    const args = parse.mock.calls[0][0]
    expect(args.model).toBe("claude-sonnet-4-6")
    expect(args.max_tokens).toBe(1024)
    expect(args.system[0].cache_control).toEqual({ type: "ephemeral" })
    expect(args.system[0].text).toContain("email triage assistant")
    expect(args.messages[0].role).toBe("user")
    // email text + the closing fence that follows {{EMAIL}}
    expect(args.messages[0].content).toContain("Pay up")
    expect(args.messages[0].content.trimEnd().endsWith("---")).toBe(true)
    // structured output via output_config.format — NOT the deprecated output_format
    expect(args.output_config?.format).toBeDefined()
    expect(args.output_format).toBeUndefined()
  })

  it("passes no sampling params (rejected on 4.x)", async () => {
    parse.mockResolvedValueOnce({ parsed_output: RESULT, stop_reason: "end_turn" })
    await classify("x")
    const args = parse.mock.calls[0][0]
    expect(args.temperature).toBeUndefined()
    expect(args.top_p).toBeUndefined()
    expect(args.top_k).toBeUndefined()
  })

  it("throws when there is no parsed output", async () => {
    parse.mockResolvedValueOnce({ parsed_output: null, stop_reason: "max_tokens" })
    await expect(classify("x")).rejects.toThrow(/no parsed output.*max_tokens/)
  })

  it("exposes the model + prompt_version matching the Python pipeline", () => {
    expect(MODEL).toBe("claude-sonnet-4-6")
    expect(PROMPT_VERSION).toBe("7c1d3d3b41bc")
  })
})
