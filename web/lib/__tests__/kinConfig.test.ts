import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"

vi.mock("server-only", () => ({}))

import { readKinConfig, applyTuning } from "@/lib/kinConfig"

let tmpDir: string
let tomlPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kin-cfg-"))
  tomlPath = path.join(tmpDir, "kin.toml")
  process.env.KIN_TOML_PATH = tomlPath
})

afterEach(async () => {
  delete process.env.KIN_TOML_PATH
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("kinConfig", () => {
  it("returns empty arrays when the file is missing", async () => {
    expect(await readKinConfig()).toEqual({
      sender_allowlist: [],
      sender_blocklist: [],
      subject_keywords: [],
    })
  })

  it("creates the file and adds entries when missing", async () => {
    const added = await applyTuning({ allow: ["a@x.com"], block: ["b@y.com"], keyword: ["bill"] })
    expect(added).toEqual({ sender_allowlist: 1, sender_blocklist: 1, subject_keywords: 1 })
    const cfg = await readKinConfig()
    expect(cfg.sender_allowlist).toContain("a@x.com")
    expect(cfg.sender_blocklist).toContain("b@y.com")
    expect(cfg.subject_keywords).toContain("bill")
  })

  it("dedupes case-insensitively and preserves existing entries", async () => {
    await fs.writeFile(
      tomlPath,
      `[filters]\nsender_allowlist = [\n    "keep@x.com",\n]\nsender_blocklist = []\nsubject_keywords = []\n`
    )
    const added = await applyTuning({ allow: ["KEEP@x.com", "new@x.com"] })
    expect(added.sender_allowlist).toBe(1)
    const cfg = await readKinConfig()
    expect([...cfg.sender_allowlist].sort()).toEqual(["keep@x.com", "new@x.com"])
  })

  it("rejects unsafe entries (embedded quotes / newlines)", async () => {
    await applyTuning({ allow: ['bad"quote', "ok@x.com"] })
    const cfg = await readKinConfig()
    expect(cfg.sender_allowlist).toEqual(["ok@x.com"])
  })

  it("preserves comments and untouched arrays", async () => {
    await fs.writeFile(
      tomlPath,
      `# my comment\n[filters]\nsender_allowlist = []\nsender_blocklist = []\nsubject_keywords = [\n    "bill",\n]\n`
    )
    await applyTuning({ allow: ["a@x.com"] })
    const text = await fs.readFile(tomlPath, "utf8")
    expect(text).toContain("# my comment")
    expect(text).toContain("bill")
    expect(text).toContain("a@x.com")
  })
})
