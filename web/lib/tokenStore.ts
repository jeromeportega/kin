import fs from "fs/promises"
import path from "path"
import { randomBytes } from "crypto"
import { usingTurso, dbClient } from "./db"

// SECURITY NOTE: Refresh tokens are stored in plaintext JSON at mode 0600.
// A Gmail refresh_token grants long-term read access to a user's inbox.
// Before a multi-tenant or internet-facing production deployment, token values
// should be encrypted at rest (e.g. AES-256-GCM with a KMS- or env-var-backed key).
// The current plaintext-on-disk approach is acceptable for single-user local deployments only.
// TODO(sec): add token encryption before broader deployment.

// Anchored to the source-tree root for local dev. In production (Next.js standalone,
// Docker, etc.), __dirname resolves to the compiled output directory, so the relative
// path to data/ would be wrong. Always set KIN_TOKEN_STORE_PATH explicitly in production.
const DEFAULT_TOKEN_STORE = path.resolve(__dirname, "../../data/gmail_tokens.json")
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

// Cross-process advisory lock: uses O_EXCL (atomic on POSIX) to serialise concurrent
// writers across Node.js workers, PM2 clusters, and Lambda containers.
// Falls back to stale-lock removal if a writer crashed without releasing (5 s threshold).
async function acquireLock(
  lockPath: string,
  timeoutMs = 5000
): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs
  let delay = 10

  while (true) {
    try {
      // "wx" flag = O_EXCL | O_CREAT | O_WRONLY — creation is atomic on POSIX.
      await fs.writeFile(lockPath, `${process.pid}`, { flag: "wx", mode: 0o600 })
      return async () => {
        try {
          await fs.unlink(lockPath)
        } catch {
          // Lock file already removed — no-op.
        }
      }
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err

      // Stale-lock check: if the lock file is older than 5 s the holder likely crashed.
      try {
        const stat = await fs.stat(lockPath)
        if (Date.now() - stat.mtimeMs > 5000) {
          await fs.unlink(lockPath)
          continue // retry the acquire immediately
        }
      } catch {
        // Lock file disappeared between our EEXIST and stat — retry.
      }

      if (Date.now() >= deadline) {
        throw new Error(`Could not acquire token-store lock within ${timeoutMs}ms`)
      }
      await new Promise<void>((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, 200) // exponential back-off, capped at 200 ms
    }
  }
}

async function doWrite(email: string, refreshToken: string): Promise<void> {
  const storePath = tokenStorePath()
  const lockPath = `${storePath}.lock`
  const dir = path.dirname(storePath)

  // mode 0o700: keep the directory private so its listing is not world-readable.
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })

  const releaseLock = await acquireLock(lockPath)
  try {
    let store: Record<string, TokenEntry> = {}
    try {
      const existing = await fs.readFile(storePath, "utf-8")
      const parsed: unknown = JSON.parse(existing)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        store = parsed as Record<string, TokenEntry>
      }
    } catch {
      // File doesn't exist yet or is unparseable — start fresh.
    }

    store[email] = {
      refresh_token: refreshToken,
      scope: GMAIL_SCOPE,
      updated_at: new Date().toISOString(),
    }

    const json = JSON.stringify(store, null, 2)
    // Unique suffix per call (PID + random) so concurrent tmp files never collide.
    const suffix = `${process.pid}.${randomBytes(8).toString("hex")}`
    const tmpPath = `${storePath}.${suffix}.tmp`
    await fs.writeFile(tmpPath, json, { mode: 0o600 })
    await fs.rename(tmpPath, storePath)
    // No fs.chmod needed: rename preserves the mode already set on the temp file.
  } finally {
    await releaseLock()
  }
}

export async function writeRefreshToken(
  email: string,
  refreshToken: string
): Promise<void> {
  if (usingTurso()) {
    await dbClient().execute({
      sql: `INSERT INTO gmail_tokens (email, refresh_token, scope, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (email) DO UPDATE SET
              refresh_token = excluded.refresh_token,
              scope = excluded.scope,
              updated_at = excluded.updated_at`,
      args: [email, refreshToken, GMAIL_SCOPE, new Date().toISOString()],
    })
    return
  }
  await doWrite(email, refreshToken)
}

export async function readRefreshToken(email: string): Promise<string | null> {
  if (usingTurso()) {
    const rs = await dbClient().execute({
      sql: "SELECT refresh_token FROM gmail_tokens WHERE email = ?",
      args: [email],
    })
    const value = rs.rows[0]?.refresh_token
    return value == null ? null : String(value)
  }
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
