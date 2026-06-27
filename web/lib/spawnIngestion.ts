import "server-only"
import path from "path"
import { spawn } from "child_process"

const TIMEOUT_MS = 5 * 60 * 1000

// Sentinel exit code for a spawn timeout — matches the `timeout` utility convention.
// route.ts maps this to HTTP 504.
export const TIMEOUT_EXIT = 124

// The ingest package lives at the repo root, not inside web/.
// Next.js sets process.cwd() to the web/ subdirectory, so we go one level up.
// Set KIN_REPO_ROOT to override when the cwd assumption does not hold.
const REPO_ROOT = process.env.KIN_REPO_ROOT ?? path.resolve(process.cwd(), "..")

// Vars the ingest subprocess actually reads — keeps the secret surface minimal
// rather than forwarding the entire Next.js process environment.
function buildEnv(): NodeJS.ProcessEnv {
  const keys = [
    "PATH",
    "HOME",
    "KIN_REPO_ROOT",
    "KIN_DB_PATH",
    "KIN_TOKEN_STORE_PATH",
    "KIN_CONFIG_PATH",
    "AUTH_GOOGLE_ID",
    "AUTH_GOOGLE_SECRET",
  ] as const
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV }
  for (const k of keys) {
    if (process.env[k] !== undefined) env[k] = process.env[k]
  }
  return env
}

export function spawnIngestion(email: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("uv", ["run", "-m", "ingest.run", "--user", email], {
      cwd: REPO_ROOT,
      // Use "pipe" for stderr to prevent PII (email addresses, OAuth errors) from
      // appearing as unstructured noise in shared server logs.
      stdio: ["ignore", "ignore", "pipe"],
      env: buildEnv(),
    })

    // Discard captured stderr — structured logging belongs in the route handler.
    child.stderr?.resume()

    let settled = false
    const settle = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code)
    }

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      // Follow up with SIGKILL in case the process ignores SIGTERM.
      const killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL")
      }, 5_000)
      killTimer.unref()
      settle(TIMEOUT_EXIT)
    }, TIMEOUT_MS)

    child.on("error", () => settle(1))
    child.on("close", (code) => settle(code ?? 1))
  })
}
