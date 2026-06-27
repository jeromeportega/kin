import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { writeRefreshToken, readRefreshToken } from "@/lib/tokenStore"

let tmpDir: string
let tmpFile: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tokenStore-test-"))
  tmpFile = path.join(tmpDir, "gmail_tokens.json")
  process.env.KIN_TOKEN_STORE_PATH = tmpFile
})

afterEach(async () => {
  delete process.env.KIN_TOKEN_STORE_PATH
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// ─── helpers ─────────────────────────────────────────────────────────────────

async function readStore(): Promise<Record<string, any>> {
  const content = await fs.readFile(tmpFile, "utf-8")
  return JSON.parse(content)
}

// ─── writeRefreshToken ────────────────────────────────────────────────────────

describe("writeRefreshToken", () => {
  it("creates the token store file with mode 0600", async () => {
    await writeRefreshToken("alice@example.com", "rt_alice")

    const stat = await fs.stat(tmpFile)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it("persists refresh_token, scope, and updated_at keyed by email", async () => {
    const before = new Date()
    await writeRefreshToken("alice@example.com", "rt_alice_token")
    const after = new Date()

    const store = await readStore()
    const entry = store["alice@example.com"]

    expect(entry).toBeDefined()
    expect(entry.refresh_token).toBe("rt_alice_token")
    expect(entry.scope).toBe("https://www.googleapis.com/auth/gmail.readonly")
    expect(typeof entry.updated_at).toBe("string")

    const updatedAt = new Date(entry.updated_at)
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000)
    expect(updatedAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1000)
  })

  // ─── atomic upsert ─────────────────────────────────────────────────────────

  it("preserves existing entries when adding a new user", async () => {
    await writeRefreshToken("bob@example.com", "rt_bob")
    await writeRefreshToken("alice@example.com", "rt_alice")

    const store = await readStore()
    expect(store["bob@example.com"]?.refresh_token).toBe("rt_bob")
    expect(store["alice@example.com"]?.refresh_token).toBe("rt_alice")
  })

  it("updates refresh_token and updated_at when re-writing an existing user", async () => {
    await writeRefreshToken("alice@example.com", "rt_old")
    const storeAfterFirst = await readStore()
    const firstUpdatedAt = storeAfterFirst["alice@example.com"].updated_at

    // Ensure at least 1ms passes so updated_at can differ
    await new Promise((r) => setTimeout(r, 5))

    await writeRefreshToken("alice@example.com", "rt_new")
    const storeAfterSecond = await readStore()
    const entry = storeAfterSecond["alice@example.com"]

    expect(entry.refresh_token).toBe("rt_new")
    expect(new Date(entry.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(firstUpdatedAt).getTime()
    )
  })

  it("keeps other users' entries when updating one user", async () => {
    await writeRefreshToken("bob@example.com", "rt_bob")
    await writeRefreshToken("alice@example.com", "rt_alice_v1")
    await writeRefreshToken("alice@example.com", "rt_alice_v2")

    const store = await readStore()
    expect(store["bob@example.com"]?.refresh_token).toBe("rt_bob")
    expect(store["alice@example.com"]?.refresh_token).toBe("rt_alice_v2")
  })

  it("handles a corrupt store file (invalid JSON) by starting fresh", async () => {
    await fs.writeFile(tmpFile, "not valid json", { mode: 0o600 })
    await writeRefreshToken("alice@example.com", "rt_alice")

    const store = await readStore()
    expect(store["alice@example.com"]?.refresh_token).toBe("rt_alice")
  })

  it("handles a store file containing non-object JSON (null) by starting fresh", async () => {
    await fs.writeFile(tmpFile, "null", { mode: 0o600 })
    await writeRefreshToken("alice@example.com", "rt_alice")

    const store = await readStore()
    expect(store["alice@example.com"]?.refresh_token).toBe("rt_alice")
  })

  it("handles a store file containing a JSON array by starting fresh", async () => {
    await fs.writeFile(tmpFile, "[]", { mode: 0o600 })
    await writeRefreshToken("alice@example.com", "rt_alice")

    const store = await readStore()
    expect(store["alice@example.com"]?.refresh_token).toBe("rt_alice")
  })

  // ─── round-trip readback (AC4) ────────────────────────────────────────────

  it("round-trip: token written can be read back by email", async () => {
    await writeRefreshToken("user@example.com", "rt_roundtrip")

    const store = await readStore()
    expect(store["user@example.com"]?.refresh_token).toBe("rt_roundtrip")
  })

  // ─── scope field ─────────────────────────────────────────────────────────

  it("always writes gmail.readonly as the scope, not any broader scope", async () => {
    await writeRefreshToken("user@example.com", "rt_tok")

    const store = await readStore()
    expect(store["user@example.com"].scope).toBe(
      "https://www.googleapis.com/auth/gmail.readonly"
    )
    expect(store["user@example.com"].scope).not.toContain("gmail.modify")
    expect(store["user@example.com"].scope).not.toContain("gmail.send")
    expect(store["user@example.com"].scope).not.toContain("https://mail.google.com/")
  })

  // ─── concurrent write serialization ─────────────────────────────────────

  it("serializes concurrent writes — all entries survive racing calls", async () => {
    await Promise.all([
      writeRefreshToken("userA@example.com", "rt_A"),
      writeRefreshToken("userB@example.com", "rt_B"),
      writeRefreshToken("userC@example.com", "rt_C"),
    ])

    const store = await readStore()
    expect(store["userA@example.com"]?.refresh_token).toBe("rt_A")
    expect(store["userB@example.com"]?.refresh_token).toBe("rt_B")
    expect(store["userC@example.com"]?.refresh_token).toBe("rt_C")
  })
})

// ─── readRefreshToken ─────────────────────────────────────────────────────────

describe("readRefreshToken", () => {
  it("returns the persisted refresh_token for a known email", async () => {
    await writeRefreshToken("user@example.com", "rt_readable")
    const token = await readRefreshToken("user@example.com")
    expect(token).toBe("rt_readable")
  })

  it("returns null for an email not in the store", async () => {
    await writeRefreshToken("someone@example.com", "rt_someone")
    const token = await readRefreshToken("other@example.com")
    expect(token).toBeNull()
  })

  it("returns null when the store file does not exist", async () => {
    const token = await readRefreshToken("nobody@example.com")
    expect(token).toBeNull()
  })

  it("returns null when the store contains invalid JSON", async () => {
    await fs.writeFile(tmpFile, "not valid json", { mode: 0o600 })
    const token = await readRefreshToken("user@example.com")
    expect(token).toBeNull()
  })

  it("returns null when the store contains non-object JSON", async () => {
    await fs.writeFile(tmpFile, "null", { mode: 0o600 })
    const token = await readRefreshToken("user@example.com")
    expect(token).toBeNull()
  })
})
