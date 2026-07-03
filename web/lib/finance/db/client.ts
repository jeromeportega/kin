import "server-only"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createClient, type Client } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { dbClient } from "@/lib/db"
import * as schema from "./schema"

// The finance module uses drizzle (ported from clarity), wrapping kin's SHARED
// libSQL connection — so finance tables live in the same Turso DB (prod) / local
// SQLite file (dev) as the email tables. Email code keeps using raw dbClient();
// finance code uses financeDb(). One connection, two idioms, clean boundary.

export type FinanceDb = ReturnType<typeof drizzle<typeof schema>>

let _db: FinanceDb | null = null

export function financeDb(): FinanceDb {
  if (!_db) _db = drizzle(dbClient(), { schema })
  return _db
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations")

/** Apply every finance migration (sorted) to a client. Idempotent-ish: the DDL
 * uses CREATE TABLE, so run it against a fresh DB. */
export async function applyFinanceMigrations(client: Client): Promise<void> {
  if (!existsSync(MIGRATIONS_DIR)) return
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith(".sql"))
    .sort()
  for (const name of files) {
    const sqlText = readFileSync(join(MIGRATIONS_DIR, name), "utf8")
    if (sqlText.trim().length === 0) continue
    await client.executeMultiple(sqlText)
  }
}

/** Throwaway file: DB with the finance schema applied — the only way tests get a DB. */
export async function createTestFinanceDb(): Promise<{
  db: FinanceDb
  cleanup: () => void
  file: string
}> {
  const file = join(tmpdir(), `kin-finance-${randomUUID()}.db`)
  const client = createClient({ url: `file:${file}` })
  await applyFinanceMigrations(client)
  const db = drizzle(client, { schema })
  const cleanup = () => {
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
