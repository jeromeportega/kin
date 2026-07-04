import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createClient, type Client } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"

// The finance module's drizzle types + test-DB factory (ported from clarity). This
// file is deliberately free of "server-only" and of any kin runtime import, so the
// finance core + its tests can import it anywhere. The SHARED runtime connection
// (Turso/local, same DB as email) lives in ./runtime (financeDb).

export type FinanceDb = ReturnType<typeof drizzle>

/** Runtime finance DB — resolves kin's SHARED libSQL DB (Turso in prod, the local
 * kin.sqlite file in dev), so finance tables sit in the same DB as email. A fresh
 * client per call (clarity's semantics); the web layer holds its own singleton. */
export function createDb(): FinanceDb {
  const tursoUrl = process.env.TURSO_DATABASE_URL
  if (tursoUrl) {
    return drizzle(createClient({ url: tursoUrl, authToken: process.env.TURSO_AUTH_TOKEN }))
  }
  const file = process.env.KIN_DB_PATH ?? join(process.cwd(), "..", "data", "kin.sqlite")
  return drizzle(createClient({ url: `file:${file}` }))
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations")

/** Apply every finance migration (sorted) to a client. */
function applyMigrations(client: Client): void {
  if (!existsSync(MIGRATIONS_DIR)) return
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith(".sql"))
    .sort()
  for (const name of files) {
    const sqlText = readFileSync(join(MIGRATIONS_DIR, name), "utf8")
    if (sqlText.trim().length === 0) continue
    // Un-awaited: a single file: client serializes FIFO, so the DDL runs before
    // whatever the test awaits next (clarity's contract; keeps this sync).
    void client.executeMultiple(sqlText).catch(() => {})
  }
}

/** The ONLY way tests obtain a DB: a throwaway file: DB with the schema applied. */
export function createTestDb(): { db: FinanceDb; cleanup: () => void; file: string } {
  const file = join(tmpdir(), `kin-finance-${randomUUID()}.db`)
  const client = createClient({ url: `file:${file}` })
  const db = drizzle(client)
  applyMigrations(client)
  const cleanup = (): void => {
    try {
      client.close()
    } catch {
      /* already closed */
    }
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(`${file}${suffix}`, { force: true })
    }
  }
  return { db, cleanup, file }
}
