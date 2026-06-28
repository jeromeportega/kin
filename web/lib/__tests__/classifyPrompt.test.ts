import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { CLASSIFY_PROMPT } from "@/lib/classifyPrompt"

// app/prompts/classify.txt is the canonical source (the Python eval reads it);
// web/lib/classifyPrompt.ts is generated from it via scripts/gen-classify-prompt.mjs.
// These guards fail if they drift — regenerate to fix, so the prompt_version
// (and thus the dedup cache) stays consistent across both pipelines.
const SOURCE = path.resolve(process.cwd(), "../app/prompts/classify.txt")

describe("classifyPrompt", () => {
  it("is byte-identical to the canonical app/prompts/classify.txt", () => {
    expect(CLASSIFY_PROMPT).toBe(fs.readFileSync(SOURCE, "utf8"))
  })

  it("hashes to the same prompt_version as the Python pipeline", () => {
    const version = createHash("sha256").update(CLASSIFY_PROMPT).digest("hex").slice(0, 12)
    expect(version).toBe("b4e9c57d4d9a")
  })
})
