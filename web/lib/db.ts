import "server-only"
import path from "path"
import { createClient, type Client } from "@libsql/client"

// The web layer talks to the same DB as the Python pipeline via libSQL:
// Turso over HTTP in production (Vercel), or the local SQLite file in dev. The
// reads (digest, classifications) always use this client; the config/token code
// uses it only on the Turso path (usingTurso()) and local files otherwise.

let _client: Client | null = null

/** Shared libSQL client — Turso in production, the local SQLite file in dev. */
export function dbClient(): Client {
  if (!_client) {
    if (process.env.TURSO_DATABASE_URL) {
      _client = createClient({
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN,
      })
    } else {
      // Resolved at call time so the bundler doesn't trace the whole project.
      const file = process.env.KIN_DB_PATH ?? path.resolve(process.cwd(), "../data/kin.sqlite")
      _client = createClient({ url: `file:${file}` })
    }
  }
  return _client
}
