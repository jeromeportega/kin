# kin dashboard — web

Next.js App Router dashboard for the kin personal AI email triage system.

## Stack

- Next.js (App Router, TypeScript)
- Tailwind CSS v4
- shadcn/ui (button, card, badge, accordion, skeleton, separator)
- Vitest + React Testing Library

## Local setup

1. Copy env template:
   ```bash
   cp .env.example .env.local
   ```

2. Fill in `.env.local` (see comments in the file for instructions):
   - `AUTH_SECRET` — generate with `openssl rand -base64 32`
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from Google Cloud Console
   - `KIN_API_BASE_URL` — URL of the running kin FastAPI server (default `http://127.0.0.1:8000`)
   - `KIN_DEMO_USER` — optional; maps all logins to a single kin user_id

3. Install dependencies:
   ```bash
   npm install
   ```

4. Start the dev server:
   ```bash
   npm run dev
   ```

## Running tests

```bash
npm test
```

## Environment variables

See `.env.example` for the full list with descriptions. **Never commit `.env.local`** — it is gitignored.
