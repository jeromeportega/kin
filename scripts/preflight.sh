#!/usr/bin/env bash
# scripts/preflight.sh — the full LOCAL pre-deploy check.
#
# Runs everything a deploy exercises, on your machine, so you catch the
# wiring/build/serve failures that the fast unit gate alone can't see:
#   1. unit gate      — pytest + tsc + vitest (scripts/test.sh)
#   2. production build — next build
#   3. Playwright E2E  — golden paths against a locally-started dev server
#
# No Docker required: Playwright ships its own browser, the DB is a local SQLite
# file, and uv/node are your toolchain. Point the E2E at a deployed URL instead
# with E2E_BASE_URL=https://… (step 3 then skips starting a local server).
#
# Usage:  bash scripts/preflight.sh
set -uo pipefail

export PATH="$HOME/Library/Python/3.9/bin:$HOME/.local/bin:$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
fail=0

echo "=== 1/3  unit gate — pytest + tsc + vitest ==="
bash scripts/test.sh || { echo "  x unit gate FAILED"; fail=1; }

echo
echo "=== 2/3  production build — next build ==="
( cd web && npm run build ) || { echo "  x build FAILED"; fail=1; }

echo
echo "=== 3/3  Playwright golden-path E2E ==="
( cd web && npm run e2e ) || { echo "  x e2e FAILED"; fail=1; }

echo
if [ "$fail" -ne 0 ]; then
  echo "PREFLIGHT: FAIL"
  exit 1
fi
echo "PREFLIGHT: PASS -- safe to deploy"
