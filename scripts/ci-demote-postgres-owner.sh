#!/usr/bin/env bash
# Provision the restricted application role and demote the disposable migration
# owner after schema migrations have completed.

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

if [ "${CI_HOST_POSTGRES:-0}" = "1" ]; then
  : "${VOLTMIND_CI_PROVISIONING_TARGET:?provisioning target must be explicit}"
  if [ "$VOLTMIND_CI_PROVISIONING_TARGET" != 'host-ci' ]; then
    echo 'ERROR: refusing an unknown Host Postgres provisioning target' >&2
    exit 1
  fi
  : "${VOLTMIND_RESTRICTED_DATABASE_URL:?restricted database URL must be set}"

  current_role="$(psql "$DATABASE_URL" -Atqc 'SELECT current_user')"
  if [ "$current_role" != 'voltmind_test_owner' ]; then
    echo 'ERROR: host-ci DATABASE_URL must use voltmind_test_owner' >&2
    exit 1
  fi

  # This URL must point only at the disposable CI database. The owner is
  # checked by name before any ACL or role mutation is attempted.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
REVOKE ALL ON FUNCTION public.voltmind_admin_source_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.voltmind_admin_source_ids() TO voltmind_restricted;
DO $$
DECLARE
  owner_is_superuser boolean;
BEGIN
  SELECT rolsuper INTO owner_is_superuser
    FROM pg_roles WHERE rolname = current_user;
  IF owner_is_superuser THEN
    EXECUTE format(
      'ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
      current_user
    );
  END IF;
END
$$;
SQL

  role_postcondition="$(psql "$DATABASE_URL" -Atqc "
    SELECT owner.rolsuper::text || '|' || owner.rolbypassrls::text || '|' ||
           restricted.rolsuper::text || '|' || restricted.rolbypassrls::text || '|' ||
           has_function_privilege('public', 'public.voltmind_admin_source_ids()', 'EXECUTE')::text || '|' ||
           has_function_privilege('voltmind_restricted', 'public.voltmind_admin_source_ids()', 'EXECUTE')::text
      FROM pg_roles owner
      JOIN pg_roles restricted ON restricted.rolname = 'voltmind_restricted'
     WHERE owner.rolname = current_user
  ")"
  echo "Host-ci observed role/ACL state: $role_postcondition" >&2
  if [ "$role_postcondition" != 'f|f|f|f|f|t' ]; then
    echo 'ERROR: host-ci Postgres role/ACL postcondition failed' >&2
    exit 1
  fi
  echo 'Host-ci Postgres provisioning postconditions passed.'
  exit 0
fi

: "${PGPASSWORD:?PGPASSWORD must be the bootstrap-only service password}"

case "$DATABASE_URL" in
  postgresql://voltmind_test_owner:*@127.0.0.1:5432/voltmind_ci) ;;
  *) echo 'ERROR: refusing to demote a non-disposable CI Postgres URL' >&2; exit 1 ;;
esac

: "${VOLTMIND_RLS_RESTRICTED_PASSWORD:?restricted role password must be set by ci-bootstrap-postgres.sh}"

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
