import "server-only"
import { spawn } from "child_process"

const TIMEOUT_MS = 5 * 60 * 1000

export function spawnIngestion(email: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("uv", ["run", "-m", "ingest.run", "--user", email], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "inherit"],
    })

    let settled = false
    const settle = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code)
    }

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      settle(1)
    }, TIMEOUT_MS)

    child.on("error", () => settle(1))
    child.on("close", (code) => settle(code ?? 1))
  })
}
