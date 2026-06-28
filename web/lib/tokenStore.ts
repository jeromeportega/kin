import { dbClient } from "./db"

// SECURITY: refresh tokens are stored as plaintext in the DB (gmail_tokens). A
// Gmail refresh_token grants long-term read access to an inbox. Before a
// multi-tenant or broader production deployment, encrypt token values at rest
// (e.g. AES-256-GCM with a KMS-/env-backed key).
// TODO(sec): add token encryption before broad use.

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"

export async function writeRefreshToken(email: string, refreshToken: string): Promise<void> {
  await dbClient().execute({
    sql: `INSERT INTO gmail_tokens (email, refresh_token, scope, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (email) DO UPDATE SET
            refresh_token = excluded.refresh_token,
            scope = excluded.scope,
            updated_at = excluded.updated_at`,
    args: [email, refreshToken, GMAIL_SCOPE, new Date().toISOString()],
  })
}

export async function readRefreshToken(email: string): Promise<string | null> {
  const rs = await dbClient().execute({
    sql: "SELECT refresh_token FROM gmail_tokens WHERE email = ?",
    args: [email],
  })
  const value = rs.rows[0]?.refresh_token
  return value == null ? null : String(value)
}
