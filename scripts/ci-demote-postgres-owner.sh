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

  # Host CI uses the non-privileged runtime role. The disposable database's
  # owner, ACL, and role state are provisioned separately; this job verifies
  # them without attempting no-op ACL DDL that it cannot authorize.
  #
  # v0.41.21.3 (HTTP Host runtime isolation): the Host refuses to start
  # unless the runtime role is a member of the NOLOGIN control-plane role
  # `voltmind_oauth_runtime` (created by migration v129). The OAuth HTTP E2E
  # runs the Host as `voltmind_restricted`, so that role must carry the
  # membership, or the E2E fails at startup.

  role_postcondition="$(psql "$DATABASE_URL" -Atqc "
    SELECT owner.rolsuper::text || '|' || owner.rolbypassrls::text || '|' ||
           restricted.rolsuper::text || '|' || restricted.rolbypassrls::text || '|' ||
           has_function_privilege('public', 'public.voltmind_admin_source_ids()', 'EXECUTE')::text || '|' ||
           has_function_privilege('voltmind_restricted', 'public.voltmind_admin_source_ids()', 'EXECUTE')::text || '|' ||
           EXISTS (
             SELECT 1 FROM pg_auth_members m
             JOIN pg_roles r ON r.oid = m.roleid
             WHERE r.rolname = 'voltmind_oauth_runtime'
               AND m.member::regrole::text = 'voltmind_restricted'
           )::text
      FROM pg_roles owner
      JOIN pg_roles restricted ON restricted.rolname = 'voltmind_restricted'
     WHERE owner.rolname = current_user
  ")"
  echo "Host-ci observed role/ACL state: $role_postcondition" >&2
  # PostgreSQL renders boolean::text as "true" / "false", not "t" / "f".
  # Last column: voltmind_restricted must be a member of voltmind_oauth_runtime
  # so the HTTP Host runtime-isolation guard passes.
  if [ "$role_postcondition" != 'false|false|false|false|false|true|true' ]; then
    echo 'ERROR: host-ci Postgres role/ACL postcondition failed' >&2
    echo '  Expected: owner NOSUPERUSER/NOBYPASSRLS, restricted NOSUPERUSER/NOBYPASSRLS,' >&2
    echo '  voltmind_restricted has EXECUTE on voltmind_admin_source_ids, and' >&2
    echo '  voltmind_restricted is a MEMBER of voltmind_oauth_runtime (migration v129).' >&2
    echo '  Re-provision the Host Postgres: apply migration v129, then run' >&2
    echo '  "GRANT voltmind_oauth_runtime TO voltmind_restricted".' >&2
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
# v0.41.21.3 (HTTP Host runtime isolation): the Host requires the runtime role
# to be a member of voltmind_oauth_runtime (migration v129). Ensure the role
# exists and is granted to voltmind_restricted. The migration owner runs
# initSchema() (which applies v129) before this demote step, so the role is
# normally present; this keeps the disposable docker CI path self-contained.
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=voltmind_ci \
  psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voltmind_oauth_runtime') THEN
    EXECUTE 'CREATE ROLE voltmind_oauth_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE';
  END IF;
END
$$;
GRANT voltmind_oauth_runtime TO voltmind_restricted;
SQL
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=voltmind_ci \
  psql -v ON_ERROR_STOP=1 -c \
  'ALTER ROLE voltmind_test_owner NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'
