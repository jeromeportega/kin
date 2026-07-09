# kin — web

The kin web app (Next.js App Router): one authenticated app with two modules,
launched from the home screen (`/`).

- **Email Triage** (`/dashboard`) — your Gmail classified and digested; priorities
  surfaced, noise muted.
- **Finance** (`/finance`) — bank + retailer purchases reconciled to the item, so
  every dollar is counted once:
  - **Plaid** bank-account sync (transactions)
  - **Email-receipt import** — Amazon / Walmart / Target order emails parsed into
    item-level orders (reuses the Gmail connection; no extra setup)
  - **Reconcile** loop + a **review queue** (confirm / correct / dismiss)

## Stack

- Next.js (App Router, TypeScript) · Tailwind v4 · shadcn/ui
- Auth.js (Google OAuth) · Turso / libSQL (email module: raw `@libsql/client`;
  finance module: `drizzle-orm`) · Plaid
- Vitest + React Testing Library · Playwright (golden-path e2e)

## Local setup

1. Copy the env template and fill it in — every variable is documented inline:
   ```bash
   cp .env.example .env.local
   ```
   Minimum to boot: `AUTH_SECRET` + Google OAuth (`GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET`). Everything else is optional / feature-gated:
   Plaid (`PLAID_*`), Turso (`TURSO_*` — the app falls back to a local SQLite file
   when unset, which is what dev + tests use). See `.env.example` for the full,
   annotated list.
2. `npm install`
3. `npm run dev` → http://localhost:3000

## Testing

Run from the **repo root** unless noted.

**Unit gate** — the fast check every commit/deploy must pass (Python eval + `tsc`
+ Vitest):
```bash
bash scripts/test.sh
```

**Full local pre-deploy** — the gate plus `next build` and the Playwright
golden-path e2e. No Docker required (Playwright ships its browser; the DB is a
local SQLite file):
```bash
bash scripts/preflight.sh
```

**Web only** (from `web/`):
```bash
npm test            # Vitest (unit + component)
npm test -- <path>  # a subset, e.g. lib/finance/core/adapters/eml
npm run e2e         # Playwright golden paths (starts a dev server)
npx tsc --noEmit    # type-check
```

### Exercising the finance features locally

- **Plaid (sandbox):** set `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV=sandbox`
  in `.env.local`, then on `/finance` click **Connect a bank** and use Plaid's
  sandbox credentials (`user_good` / `pass_good`). Synced transactions flow into
  the reconcile loop and the review queue.
- **Email-receipt import:** sign in (the Email Triage sign-in grants
  `gmail.readonly`), then on `/finance` click **Import receipts from email**. It
  fetches Amazon / Walmart / Target order emails from your Gmail and lands
  item-level orders through the same reconcile path — no extra connection.

### Email-receipt parsers

Retailer parsers live in `lib/finance/core/adapters/eml/` behind a dispatch seam
(`parsers/{amazon,walmart,target}.ts`; adding a retailer is one thin config +
fixtures). They are **fail-closed**: an unrecognized or mis-parsed email is
skipped with a surfaced error, never persisted as wrong data. Tests + `.eml`
fixtures are under `lib/finance/core/adapters/eml/__tests__/`:
```bash
npm test -- lib/finance/core/adapters/eml
```
The Walmart/Target patterns are best-effort against those retailers' known email
shapes — validate against a **real** order email before relying on them (a wrong
pattern just skips the receipt, thanks to the fail-closed guards).

## Environment variables

See `.env.example` for the full annotated list. A `smoke.test.tsx` guard asserts
`.env.example` documents every variable the app reads, so it can't silently drift.
**Never commit `.env.local`** — it is gitignored.
