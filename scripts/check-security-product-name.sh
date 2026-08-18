#!/usr/bin/env bash
# Release/docs guard: SECURITY.md must identify the current product.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

if grep -Ein "gbrain" SECURITY.md >/dev/null 2>&1; then
  echo "ERROR: SECURITY.md contains the retired gbrain product name." >&2
  grep -Ein "gbrain" SECURITY.md >&2 || true
  exit 1
fi

if ! grep -q "VoltMind" SECURITY.md; then
  echo "ERROR: SECURITY.md does not contain the VoltMind product name." >&2
  exit 1
fi

echo "OK: SECURITY.md uses VoltMind naming"
