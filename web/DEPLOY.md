# Deploying kin to Vercel

kin is a single Next.js app (the Python pipeline was ported to TS). The whole
thing — UI, auth, reads, ingest/classify, and the daily digest cron — deploys as
one Vercel project from this `web/` directory.

## 1. Create the Vercel project

- New Project → import the `kin` repo.
- **Root Directory: `web`** (important — the Next.js app lives here, not the repo root).
- Framework preset: Next.js (auto-detected). Build/install commands: defaults.

## 2. Environment variables (Project → Settings → Environment Variables)

| Variable | Value | Used by |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://kin-jportega87.aws-us-west-2.turso.io` | DB (selects Turso over local SQLite) |
| `TURSO_AUTH_TOKEN` | *(from `.env.turso`)* | DB auth |
| `ANTHROPIC_API_KEY` | *(your key)* | classify |
| `AUTH_GOOGLE_ID` | *(Google OAuth client id)* | sign-in **and** Gmail ingest |
| `AUTH_GOOGLE_SECRET` | *(Google OAuth client secret)* | sign-in **and** Gmail ingest |
| `AUTH_SECRET` | *(random 32+ bytes — `openssl rand -base64 32`)* | next-auth session |
| `AUTH_URL` | `https://<your-vercel-domain>` | next-auth OAuth callback base |
| `CRON_SECRET` | *(random string)* | guards `/api/cron` |

(Auth, the proxy, and the ingest all accept **either** name — `AUTH_GOOGLE_*` or
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` — so the two above are sufficient.)

## 3. Google OAuth redirect URI

In Google Cloud Console → your OAuth client → **Authorized redirect URIs**, add:

```
https://<your-vercel-domain>/api/auth/callback/google
```

(Keep `http://localhost:3000/api/auth/callback/google` for local dev.)

## 4. Deploy + verify

- Deploy. The daily digest cron (`vercel.json` → `/api/cron` at 13:00 UTC) is
  registered automatically.
- Visit `https://<your-vercel-domain>/signin`, sign in with Google, click **Sync**.
  That runs the TS pipeline (Gmail → filter → classify → persist → digest) against
  Turso, and the dashboard tabs + digest populate.

The DB is already seeded (schema + your filter config + Gmail token), so the first
deploy is functional. `/api/sync` and `/api/cron` are configured for up to 300s.
