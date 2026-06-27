import "server-only"
import { spawn } from "child_process"

export function spawnIngestion(email: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("uv", ["run", "-m", "ingest.run", "--user", email], {
      cwd: process.cwd(),
    })
    child.on("close", (code) => resolve(code ?? 1))
    child.on("error", () => resolve(1))
  })
}
