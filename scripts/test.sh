#!/usr/bin/env bash
# scripts/test.sh — monorepo test runner for kin.
#
# loom's integration gate points here (policy.yaml: test_command "bash scripts/test.sh").
# Runs every module's suite that EXISTS and skips modules not present yet, so it
# works today (app + api) and lights up web/ automatically once that module lands.
#
# It accumulates failures instead of &&-short-circuiting, and prints a per-suite
# status, so a broken web suite can't hide behind a green Python suite.
set -uo pipefail

# uv is a `pip --user` install whose dir isn't on the bare gate's PATH
# (/bin/sh -c) — without this, `uv` fails with exit 127 (command not found).
export PATH="$HOME/Library/Python/3.9/bin:$HOME/.local/bin:$PATH"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
fail=0

echo "== python: app + api =="
# --all-packages provisions uv WORKSPACE member deps (e.g. api/'s fastapi);
# plain `uv run pytest` only installs the root package's env.
uv run --all-packages pytest -q || { echo "  ✗ python suite FAILED"; fail=1; }

if [ -f web/package.json ]; then
  # Bare gate worktree has no node_modules — install if missing.
  ( cd web && { [ -d node_modules ] || npm ci; } ) || { echo "  ✗ web deps FAILED"; fail=1; }
  echo "== web: typecheck (tsc) =="
  # Vitest strips types — a tsc pass catches the type/build errors it can't
  # (e.g. wrong UI-library props), which would otherwise only break `next build`.
  ( cd web && npx tsc --noEmit ) || { echo "  ✗ web typecheck FAILED"; fail=1; }
  echo "== web: vitest =="
  ( cd web && npm test -- --run ) || { echo "  ✗ web suite FAILED"; fail=1; }
else
  echo "== web: skipped (web/ not present) =="
fi

if [ "$fail" -ne 0 ]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"
