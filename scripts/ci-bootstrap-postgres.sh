#!/usr/bin/env bash
# Bootstrap an ephemeral GitHub Actions Postgres service for Host white-box E2E.
#
# The service starts with a disposable superuser only so extensions and the
# migration/test owner can be provisioned. Tests receive only the owner URL;
# they never receive a production connection string.

set -euo pipefail

: "${GITHUB_ENV:?GITHUB_ENV must be provided by GitHub Actions}"
: "${PGHOST:?PGHOST must point at the disposable service}"
: "${PGPORT:?PGPORT must point at the disposable service}"
: "${PGUSER:?PGUSER must be the bootstrap-only service user}"
: "${PGPASSWORD:?PGPASSWORD must be the bootstrap-only service password}"
: "${PGDATABASE:?PGDATABASE must be the disposable test database}"

if [ "$PGHOST" != '127.0.0.1' ] || [ "$PGPORT" != '5432' ] || [ "$PGDATABASE" != 'voltmind_ci' ]; then
  echo 'ERROR: refusing to bootstrap a non-disposable CI Postgres target' >&2
  exit 1
fi

owner_password=$(openssl rand -hex 24)
owner_url="postgresql://voltmind_test_owner:${owner_password}@${PGHOST}:${PGPORT}/${PGDATABASE}"

# The owner is temporarily SUPERUSER so the fresh-schema migration can create
# PostgreSQL's event trigger. The next CI step initializes the schema and
# immediately demotes this same role to NOSUPERUSER/BYPASSRLS before E2E.
psql -v ON_ERROR_STOP=1 <<SQL
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE voltmind_test_owner
  LOGIN PASSWORD '${owner_password}'
  SUPERUSER NOCREATEDB CREATEROLE BYPASSRLS;
ALTER DATABASE ${PGDATABASE} OWNER TO voltmind_test_owner;
SQL

printf '::add-mask::%s\n' "$owner_password"
printf '::add-mask::%s\n' "$owner_url"
printf 'DATABASE_URL=%s\n' "$owner_url" >> "$GITHUB_ENV"

case "${1:-owner}" in
  owner)
    ;;
  restricted)
    restricted_password=$(openssl rand -hex 24)
    restricted_url="postgresql://voltmind_restricted:${restricted_password}@${PGHOST}:${PGPORT}/${PGDATABASE}"
    printf '::add-mask::%s\n' "$restricted_password"
    printf '::add-mask::%s\n' "$restricted_url"
    printf 'VOLTMIND_RLS_SETUP_DATABASE_URL=%s\n' "$owner_url" >> "$GITHUB_ENV"
    printf 'VOLTMIND_RLS_RESTRICTED_PASSWORD=%s\n' "$restricted_password" >> "$GITHUB_ENV"
    printf 'VOLTMIND_RESTRICTED_DATABASE_URL=%s\n' "$restricted_url" >> "$GITHUB_ENV"
    ;;
  *)
    echo 'ERROR: usage: ci-bootstrap-postgres.sh [owner|restricted]' >&2
    exit 2
    ;;
esac
