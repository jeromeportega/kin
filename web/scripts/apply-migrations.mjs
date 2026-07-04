// Apply the finance drizzle migrations to a RUNTIME libSQL database.
//
// createDb() (lib/finance/db/client.ts) applies migrations only to the throwaway
// TEST db; the shared runtime db (local kin.sqlite in dev, Turso in prod) is not
// auto-migrated. This script fills that gap and is safe to re-run: each DDL
// statement that has already been applied ("already exists" / "duplicate column")
// is skipped, so it converges the target to the latest schema idempotently.
//
// Usage:
//   node scripts/apply-migrations.mjs            # local dev db (KIN_DB_PATH or ../data/kin.sqlite)
//   node scripts/apply-migrations.mjs --turso    # Turso (needs TURSO_DATABASE_URL + TURSO_AUTH_TOKEN)
//
// Load creds with an --env-file, e.g.:
//   node --env-file=../.env.turso scripts/apply-migrations.mjs --turso
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '..', 'lib', 'finance', 'db', 'migrations');
const useTurso = process.argv.includes('--turso');

function makeClient() {
  if (useTurso) {
    const url = process.env.TURSO_DATABASE_URL;
    if (!url) throw new Error('TURSO_DATABASE_URL is not set (pass --env-file=../.env.turso)');
    return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  }
  const file = process.env.KIN_DB_PATH ?? join(here, '..', '..', 'data', 'kin.sqlite');
  return createClient({ url: `file:${file}` });
}

// A DDL statement already applied on a re-run — expected, not a failure.
function alreadyApplied(message) {
  return /already exists|duplicate column|duplicate index/i.test(message);
}

async function main() {
  const client = makeClient();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql'))
    .sort();

  let applied = 0;
  let skipped = 0;
  for (const name of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
    // Drop whole-line comments first so a leading comment block doesn't get glued
    // to the statement that follows it (they share no semicolon), then split.
    const statements = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      try {
        await client.execute(stmt);
        applied++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (alreadyApplied(message)) {
          skipped++;
        } else {
          console.error(`\n✗ ${name}\n  ${stmt.split('\n')[0]}…\n  ${message}`);
          throw err;
        }
      }
    }
  }

  const target = useTurso ? 'Turso (production)' : 'local kin.sqlite';
  console.log(`✓ migrations applied to ${target}: ${applied} statement(s) run, ${skipped} already present`);
  client.close();
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
