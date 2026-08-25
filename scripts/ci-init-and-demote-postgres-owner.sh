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

  # v0.41.21.3 (HTTP Host runtime isolation): the Host refuses to start unless
  # the runtime role is a member of `voltmind_oauth_runtime` (created by
  # migration v129). The OAuth HTTP E2E runs the Host as the pre-provisioned
  # `voltmind_restricted` role (its URL is injected as
  # VOLTMIND_RESTRICTED_DATABASE_URL), so that role must carry the
  # control-plane membership. Ensure it idempotently here; the postcondition
  # is re-verified in ci-demote-postgres-owner.sh. If the role already exists
  # with the grant, this is a no-op.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  can_create boolean;
  owner_superuser boolean;
  oauth_exists boolean;
  restricted_member boolean;
BEGIN
  SELECT (rolsuper OR rolcreaterole) INTO can_create
    FROM pg_roles WHERE rolname = current_user;
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voltmind_oauth_runtime')
    INTO oauth_exists;
  IF NOT oauth_exists THEN
    IF NOT can_create THEN
      RAISE EXCEPTION 'host-ci cannot create voltmind_oauth_runtime (owner lacks CREATEROLE)';
    END IF;
    EXECUTE 'CREATE ROLE voltmind_oauth_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE';
    EXECUTE 'GRANT voltmind_oauth_runtime TO voltmind_restricted';
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM pg_auth_members m
      JOIN pg_roles r ON r.oid = m.roleid
      WHERE r.rolname = 'voltmind_oauth_runtime'
        AND m.member::regrole::text = 'voltmind_restricted'
    ) INTO restricted_member;
    SELECT (rolsuper OR pg_has_role(current_user, (SELECT oid FROM pg_roles WHERE rolname = 'voltmind_oauth_runtime'), 'MEMBER'))
      INTO owner_superuser;
    IF NOT restricted_member THEN
      IF NOT owner_superuser THEN
        RAISE EXCEPTION 'voltmind_restricted is not a member of voltmind_oauth_runtime and owner cannot grant it; re-provision Host Postgres with migration v129 + GRANT';
      END IF;
      EXECUTE 'GRANT voltmind_oauth_runtime TO voltmind_restricted';
    END IF;
  END IF;
END
$$;
SQL
  echo "Host-ci ensured voltmind_oauth_runtime membership for voltmind_restricted."
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
