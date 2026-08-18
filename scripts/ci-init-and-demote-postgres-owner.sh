#!/usr/bin/env bash
# Initialize the disposable database, then reduce the migration/test owner
# before any white-box E2E runs use DATABASE_URL.

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set by ci-bootstrap-postgres.sh}"
: "${PGPASSWORD:?PGPASSWORD must be the bootstrap-only service password}"

case "$DATABASE_URL" in
  postgresql://voltmind_test_owner:*@127.0.0.1:5432/voltmind_ci) ;;
  *) echo 'ERROR: refusing to initialize a non-disposable CI Postgres URL' >&2; exit 1 ;;
esac


voltmin_ci_home="${RUNNER_TEMP:-/tmp}/voltmind-postgres-ci-home"
mkdir -p "$voltmin_ci_home"

# Fresh VoltMind schemas include migrations whose DDL is intentionally guarded
# by BYPASSRLS and, on PostgreSQL, a superuser-only event trigger. The role was
# created as a disposable superuser by the bootstrap step solely for this call.
VOLTMIND_HOME="$voltmin_ci_home" bun -e '
  import { PostgresEngine } from "./src/core/postgres-engine.ts";
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const engine = new PostgresEngine();
  await engine.connect({ database_url: url });
  try { await engine.initSchema(); } finally { await engine.disconnect(); }
'

PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=voltmind_ci \
  psql -v ON_ERROR_STOP=1 -c \
  'ALTER ROLE voltmind_test_owner NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'
