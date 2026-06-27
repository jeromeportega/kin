# End-to-end POC Verification — story-004-005

**Date:** 2026-06-26  
**Branch:** story/story-004-005

---

## Checklist

### Automated gate — full Vitest suite

- [x] `web/` Vitest suite passes: **56 tests across 5 files, all green**

```
 Test Files  5 passed (5)
      Tests  56 passed (56)
   Duration  771ms
```

Files covered:
- `__tests__/smoke.test.tsx` — toolchain smoke, shadcn primitives, env documentation
- `__tests__/auth-redirect.test.ts` — Google scope assertion, session strategy, dashboard guard
- `lib/__tests__/scope.test.ts` — `resolveScope` with session / KIN\_DEMO\_USER / unauthenticated
- `lib/__tests__/api.test.ts` — `fetchDigest` and `fetchClassifications` (URL, encoding, 204, errors)
- `components/digest/__tests__/digest.test.tsx` — `DigestView`, `EmptyState`, `DashboardPage` rendering

---

### Guardrail: no `gmail.readonly` scope

- [x] `web/auth.config.ts` exports `GOOGLE_SCOPE = "openid email profile"` — no `gmail.readonly` token present
- [x] `web/auth.ts` passes `GOOGLE_SCOPE` directly to the Google provider's `authorization.params.scope`
- [x] `__tests__/auth-redirect.test.ts` asserts `GOOGLE_SCOPE` equals exactly `"openid email profile"` and explicitly asserts it does NOT contain `"gmail.readonly"`
- [x] `grep -r "gmail"` across `web/` returns only the negative assertion in the test file — no production code requests the scope

---

### Guardrail: no deployment/TLS configuration

- [x] No `Dockerfile`, `docker-compose.*`, `vercel.json`, `netlify.toml`, `railway.toml`, or any cloud-hosting config file exists under `web/`
- [x] `web/next.config.ts` is a bare-minimum config with no output targets, custom domains, or TLS settings
- [x] `web/.env.example` sets `KIN_API_BASE_URL=http://127.0.0.1:8000` and `AUTH_URL=http://localhost:3000` — localhost only, no HTTPS endpoints hardcoded

---

### End-to-end manual verification path

This story is primarily a verification story. The automated Vitest suite is the green gate. For the full manual e2e path against real `'jerome'` data:

**Prerequisites:**
1. `data/kin.sqlite` present with `'jerome'` digest rows
2. `api/` running: `cd api && uv run uvicorn api.main:app --reload`
3. `.env.local` under `web/` with:
   ```
   AUTH_SECRET=<openssl rand -base64 32>
   GOOGLE_CLIENT_ID=<from console.cloud.google.com>
   GOOGLE_CLIENT_SECRET=<from console.cloud.google.com>
   KIN_API_BASE_URL=http://127.0.0.1:8000
   KIN_DEMO_USER=jerome
   ```
4. `cd web && npm run dev`

**Happy path:**
1. Navigate to `http://localhost:3000` → redirects to `/dashboard`
2. Middleware redirects unauthenticated user to `/signin`
3. Click "Sign in with Google" → OAuth consent requests only `openid email profile`
4. After sign-in, middleware lets through to `/dashboard`
5. Dashboard calls `GET /api/digest/latest?user_id=jerome` (via `KIN_DEMO_USER`)
6. Digest renders with priority sections (High / Medium / Low) grouped by category
7. `SummaryStats` shows classified / actionable / informational counts from real data

**Empty-state path:**
- If `KIN_DEMO_USER` maps to a user with no digest, the API returns `204 No Content`
- `fetchDigest` maps `204 → null`; dashboard renders `EmptyState` component, no error thrown

---

### Schema drift check

The `web/lib/types.ts` mirror of the Python `DigestModel` / `DigestItemModel` uses snake\_case keys verbatim as specified in the shared contract (Section F). Fields are:
- `DigestItem`: `classification_id`, `message_id`, `uid`, `from_addr`, `subject`, `date`, `category`, `priority`, `action_required`, `summary`, `action_items`, `dates`, `confidence`, `model`, `prompt_version`, `classified_at`
- `Digest`: `generated_at`, `user_id`, `model`, `prompt_version`, `window_hours`, `window_start`, `window_end`, `include_other`, `classified_count`, `actionable_count`, `informational_count`, `skipped_other_count`, `dropped_low_count`, `items`

No camelCase conversion. No field renaming. Matches `api/models.py` contract.

---

## Result summary

| Check | Status |
|---|---|
| Full Vitest suite (56 tests) | ✅ PASS |
| No `gmail.readonly` scope (code + test) | ✅ CONFIRMED |
| No deployment/TLS config | ✅ CONFIRMED |
| `KIN_DEMO_USER` scope wiring | ✅ CONFIRMED (tested in `api.test.ts`) |
| `204 → null` empty-state mapping | ✅ CONFIRMED (tested in `api.test.ts`) |
| TS/Pydantic field alignment | ✅ CONFIRMED (snake\_case, no drift) |
