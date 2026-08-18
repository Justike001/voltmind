#!/usr/bin/env bash
# Client/Host-MCP CI guard: these jobs must not receive a database URL.
#
# Check presence, not just value. An empty variable is still an accidental
# credential channel and makes the security boundary harder to audit.

set -euo pipefail

for name in DATABASE_URL VOLTMIND_DATABASE_URL VOLTMIND_RESTRICTED_DATABASE_URL; do
  if [ "${!name+x}" = x ]; then
    echo "ERROR: $name must be unset in Client CI and Host MCP jobs" >&2
    exit 1
  fi
done

echo "Database URL environment is absent."
