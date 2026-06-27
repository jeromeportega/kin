import fs from "fs/promises"
import path from "path"

const DEFAULT_TOKEN_STORE = "data/gmail_tokens.json"
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"

function tokenStorePath(): string {
  return process.env.KIN_TOKEN_STORE_PATH ?? DEFAULT_TOKEN_STORE
}

interface TokenEntry {
  refresh_token: string
  scope: string
  updated_at: string
}

export async function writeRefreshToken(
  email: string,
  refreshToken: string
): Promise<void> {
  const storePath = tokenStorePath()
  const dir = path.dirname(storePath)

  await fs.mkdir(dir, { recursive: true })

  let store: Record<string, TokenEntry> = {}
  try {
    const existing = await fs.readFile(storePath, "utf-8")
    store = JSON.parse(existing) as Record<string, TokenEntry>
  } catch {
    // File doesn't exist yet or is unreadable — start fresh
  }

  store[email] = {
    refresh_token: refreshToken,
    scope: GMAIL_SCOPE,
    updated_at: new Date().toISOString(),
  }

  const json = JSON.stringify(store, null, 2)
  const tmpPath = `${storePath}.${process.pid}.tmp`
  await fs.writeFile(tmpPath, json, { mode: 0o600 })
  await fs.rename(tmpPath, storePath)
  await fs.chmod(storePath, 0o600)
}
