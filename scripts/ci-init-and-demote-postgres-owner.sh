#!/usr/bin/env bash
# Initialize the disposable database as the migration/test owner
# before restricted white-box E2E runs use DATABASE_URL; CI can leave it
# in place for the preceding OAuth control-plane E2E.

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

if [ "${CI_HOST_POSTGRES:-0}" = "1" ]; then
  : "${VOLTMIND_CI_PROVISIONING_TARGET:?provisioning target must be explicit}"
  if [ "$VOLTMIND_CI_PROVISIONING_TARGET" != 'host-ci' ]; then
    echo 'ERROR: refusing an unknown Host Postgres provisioning target' >&2
    exit 1
  fi
else
  : "${PGPASSWORD:?PGPASSWORD must be the bootstrap-only service password}"
  case "$DATABASE_URL" in
    postgresql://voltmind_test_owner:*@127.0.0.1:5432/voltmind_ci) ;;
    *) echo 'ERROR: refusing to initialize a non-disposable CI Postgres URL' >&2; exit 1 ;;
  esac
fi


voltmin_ci_home="${RUNNER_TEMP:-/tmp}/voltmind-postgres-ci-home"
if [ "${CI_HOST_POSTGRES:-0}" = "1" ]; then
  current_role="$(psql "$DATABASE_URL" -Atqc 'SELECT current_user')"
  current_role_state="$(psql "$DATABASE_URL" -Atqc "SELECT rolsuper::text || '|' || rolbypassrls::text FROM pg_roles WHERE rolname = current_user")"
  if [ "$current_role" != 'voltmind_test_owner' ]; then
    echo 'ERROR: host-ci DATABASE_URL must use voltmind_test_owner' >&2
    exit 1
  fi
  echo "Host-ci pre-provisioned schema owner: $current_role ($current_role_state); skipping recurring DDL."
  exit 0
fi

mkdir -p "$voltmin_ci_home"

# Fresh VoltMind schemas include migrations whose DDL is intentionally guarded
# by BYPASSRLS and, on PostgreSQL, a superuser-only event trigger. The trusted
# host-ci path uses only the explicitly scoped disposable migration-owner URL.
VOLTMIND_HOME="$voltmin_ci_home" bun -e '
  import { PostgresEngine } from "./src/core/postgres-engine.ts";
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const engine = new PostgresEngine();
  await engine.connect({ database_url: url });
  try { await engine.initSchema(); } finally { await engine.disconnect(); }
'

# Host-ci keeps role provisioning in a separate explicit step so the migration
# owner is never silently demoted before schema initialization completes.
if [ "${CI_SKIP_OWNER_DEMOTION:-0}" = "1" ]; then
  exit 0
fi

if [ "${CI_HOST_POSTGRES:-0}" = "1" ]; then
  echo 'ERROR: host-ci requires ci-demote-postgres-owner.sh after initialization' >&2
  exit 2
fi

: "${VOLTMIND_RLS_RESTRICTED_PASSWORD:?restricted role password must be set by ci-bootstrap-postgres.sh}"
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
