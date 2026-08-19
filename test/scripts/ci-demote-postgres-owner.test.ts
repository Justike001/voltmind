/**
 * Regression coverage for Host CI's role/ACL postcondition serialization.
 *
 * PostgreSQL boolean::text emits "true" / "false". The provisioner must
 * accept that exact output after the function ACL has been repaired.
 */

import { expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/ci-demote-postgres-owner.sh');

test('accepts PostgreSQL boolean text in the Host CI ACL postcondition', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-demote-postgres-owner-'));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  const psql = join(binDir, 'psql');
  writeFileSync(psql, `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *'SELECT current_user'*) echo 'voltmind_test_owner' ;;
  *'SELECT owner.rolsuper'*) echo 'false|false|false|false|false|true' ;;
  *) cat >/dev/null ;;
esac
`);
  chmodSync(psql, 0o755);

  const result = spawnSync('bash', [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      CI_HOST_POSTGRES: '1',
      VOLTMIND_CI_PROVISIONING_TARGET: 'host-ci',
      DATABASE_URL: 'postgresql://voltmind_test_owner:unused@host/voltmind_ci',
      VOLTMIND_RESTRICTED_DATABASE_URL: 'postgresql://voltmind_restricted:unused@host/voltmind_ci',
    },
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toContain('Host-ci observed role/ACL state: false|false|false|false|false|true');
  expect(result.stdout).toContain('Host-ci Postgres provisioning postconditions passed.');
});
