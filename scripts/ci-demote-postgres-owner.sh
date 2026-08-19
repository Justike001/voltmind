#!/usr/bin/env bash
# Provision the restricted application role and demote the disposable migration
# owner after schema migrations have completed.

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set by ci-bootstrap-postgres.sh}"
: "${PGPASSWORD:?PGPASSWORD must be the bootstrap-only service password}"
: "${VOLTMIND_RLS_RESTRICTED_PASSWORD:?restricted role password must be set by ci-bootstrap-postgres.sh}"

case "$DATABASE_URL" in
  postgresql://voltmind_test_owner:*@127.0.0.1:5432/voltmind_ci) ;;
  *) echo 'ERROR: refusing to demote a non-disposable CI Postgres URL' >&2; exit 1 ;;
esac

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
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=voltmind_ci \
  psql -v ON_ERROR_STOP=1 -c \
  'GRANT EXECUTE ON FUNCTION public.voltmind_admin_source_ids() TO voltmind_restricted'
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=voltmind_ci \
  psql -v ON_ERROR_STOP=1 -c \
  'ALTER ROLE voltmind_test_owner NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'
