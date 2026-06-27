import "server-only"
import { createClient, type Client } from "@libsql/client"

// The web layer talks to the same DB as the Python pipeline. In production
// (Vercel) that's Turso, reached over HTTP; locally there is no TURSO_DATABASE_URL
// and the config/token code paths use local files instead — so this client is
// only ever instantiated on the Turso path (no embedded/native driver needed).

let _client: Client | null = null

/** True when the app should read/write the Turso DB rather than local files. */
export function usingTurso(): boolean {
  return !!process.env.TURSO_DATABASE_URL
}

/** Shared libSQL client for Turso. Only call when usingTurso() is true. */
export function turso(): Client {
  if (!_client) {
    _client = createClient({
      url: process.env.TURSO_DATABASE_URL!,
      authToken: process.env.TURSO_AUTH_TOKEN,
    })
  }
  return _client
}
