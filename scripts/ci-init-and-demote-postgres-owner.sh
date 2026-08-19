#!/usr/bin/env bash
# Initialize the disposable database, then reduce the migration/test owner
# before restricted white-box E2E runs use DATABASE_URL; CI can leave it
# in place for the preceding OAuth control-plane E2E.

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

# OAuth control-plane tables intentionally remain protected by their own RLS
# posture. CI defers demotion only to keep role provisioning explicit; the
# OAuth E2E runs after demotion against the real application role.
if [ "${CI_SKIP_OWNER_DEMOTION:-0}" = "1" ]; then
  exit 0
fi

test -n "$VOLTMIND_RLS_RESTRICTED_PASSWORD"

# Provision the non-BYPASSRLS application role before demoting the owner.
# The password is passed as a psql variable and never printed.
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=voltmind_ci \
  psql -v ON_ERROR_STOP=1 -v restricted_password="$VOLTMIND_RLS_RESTRICTED_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE voltmind_restricted LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
  :'restricted_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voltmind_restricted');
\gexec
ALTER ROLE voltmind_restricted LOGIN PASSWORD :'restricted_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
SQL
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=voltmind_ci psql -v ON_ERROR_STOP=1 -c 'GRANT EXECUTE ON FUNCTION public.voltmind_admin_source_ids() TO voltmind_restricted'
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=voltmind_ci \
  psql -v ON_ERROR_STOP=1 -c \
  'ALTER ROLE voltmind_test_owner NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'
