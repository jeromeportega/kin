import fs from "fs/promises"
import path from "path"
import { randomBytes } from "crypto"

// Anchor the default to an absolute path so it resolves correctly regardless
// of CWD (Next.js production deployments may set CWD to something other than repo root).
const DEFAULT_TOKEN_STORE = path.resolve(process.cwd(), "data/gmail_tokens.json")
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"

function tokenStorePath(): string {
  const envPath = process.env.KIN_TOKEN_STORE_PATH
  return envPath ? path.resolve(envPath) : DEFAULT_TOKEN_STORE
}

interface TokenEntry {
  refresh_token: string
  scope: string
  updated_at: string
}

// Module-level serialization: concurrent writes queue here so the
// read-modify-write cycle is never interleaved within a single process.
let _writeLock: Promise<void> = Promise.resolve()

async function doWrite(email: string, refreshToken: string): Promise<void> {
  const storePath = tokenStorePath()
  const dir = path.dirname(storePath)

  await fs.mkdir(dir, { recursive: true })

  let store: Record<string, TokenEntry> = {}
  try {
    const existing = await fs.readFile(storePath, "utf-8")
    const parsed: unknown = JSON.parse(existing)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      store = parsed as Record<string, TokenEntry>
    }
  } catch {
    // File doesn't exist yet or is unparseable — start fresh
  }

  store[email] = {
    refresh_token: refreshToken,
    scope: GMAIL_SCOPE,
    updated_at: new Date().toISOString(),
  }

  const json = JSON.stringify(store, null, 2)
  // Unique suffix per call (PID + random) to avoid collisions across concurrent
  // processes as well as rapid sequential calls within the same process.
  const suffix = `${process.pid}.${randomBytes(8).toString("hex")}`
  const tmpPath = `${storePath}.${suffix}.tmp`
  await fs.writeFile(tmpPath, json, { mode: 0o600 })
  await fs.rename(tmpPath, storePath)
  // No fs.chmod needed: rename preserves the mode already set on the temp file.
}

export async function writeRefreshToken(
  email: string,
  refreshToken: string
): Promise<void> {
  let releaseLock!: () => void
  const slot = new Promise<void>((resolve) => {
    releaseLock = resolve
  })
  const prev = _writeLock
  _writeLock = slot

  await prev
  try {
    await doWrite(email, refreshToken)
  } finally {
    releaseLock()
  }
}

export async function readRefreshToken(email: string): Promise<string | null> {
  const storePath = tokenStorePath()
  try {
    const content = await fs.readFile(storePath, "utf-8")
    const parsed: unknown = JSON.parse(content)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return (parsed as Record<string, TokenEntry>)[email]?.refresh_token ?? null
  } catch {
    return null
  }
}
