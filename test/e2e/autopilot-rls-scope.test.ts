/**
 * test/e2e/autopilot-rls-scope.test.ts
 *
 * Regression test for TODO-RLS-AUTOPILOT-2 (v0.42 follow-up, spec:
 * docs/plans/2026-08-21-autopilot-rls-submitSourceId.md).
 *
 * Proves that autopilot's enqueue paths pass `submitSourceId` so the
 * FORCE-RLS `minion_jobs` INSERT policy passes under a NON-BYPASSRLS
 * runtime role. Without the patch, enqueue under that role dies with:
 *
 *   new row violates row-level security policy for table "minion_jobs"
 *
 * Why a NEGATIVE control matters: a plain `postgres` (BYPASSRLS) harness
 * shows the insert "passing" even without the patch — that's a false green
 * because RLS never fires for a superuser. We therefore connect an engine
 * AS the least-privilege `voltmind_e2e_runtime` role (NOBYPASSRLS,
 * provisioned by provisionHttpRuntimeDatabaseUrl) and assert BOTH:
 *
 *   positive: dispatchPerSource enqueues jobs under the restricted role, and
 *   negative: a raw queue.add without submitSourceId FAILS with the RLS
 *             policy error (proves the harness actually enforced RLS).
 *
 * Run: DATABASE_URL=... bun test test/e2e/autopilot-rls-scope.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, provisionHttpRuntimeDatabaseUrl } from './helpers.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { dispatchPerSource } from '../../src/commands/autopilot-fanout.ts';
import { DEFAULT_SOURCE_ID } from '../../src/core/sync-failure-ledger.ts';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E autopilot-rls-scope tests (DATABASE_URL not set)');
}

describeE2E('autopilot enqueue under non-BYPASSRLS role (RLS source scope)', () => {
  let privileged: PostgresEngine;
  let restricted: PostgresEngine;
  let restrictedUrl: string;

  beforeAll(async () => {
    // Prepare schema on the privileged URL first (migrations, FORCE RLS,
    // config, etc.). The restricted role can read the policy but we need a
    // superuser to run migrations that enable it.
    privileged = (await setupDB()) as PostgresEngine;
    restrictedUrl = await provisionHttpRuntimeDatabaseUrl();

    restricted = new PostgresEngine();
    // poolSize forces an instance-owned pool so the restricted engine connects
    // AS the non-BYPASSRLS role (without it, connect() falls back to the
    // module-level privileged connection and the whole test is a false green).
    await restricted.connect({ database_url: restrictedUrl, poolSize: 2 });

    // Confirm the restricted engine's own pool is the non-BYPASSRLS role — if
    // the harness ever gave us the superuser URL, the negative control below
    // would silently pass and the whole test would be meaningless.
const checks = await restricted.executeRaw<{ rolbypassrls: boolean; rolsuper: boolean }>(
      `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`,
    );
    expect(checks[0].rolbypassrls).toBe(false);
    expect(checks[0].rolsuper).toBe(false);
  });

  afterAll(async () => {
    if (skip) return;
    await teardownDB();
    await restricted?.disconnect();
  });

  beforeEach(async () => {
    if (skip) return;
    // Reset the source/minion state on the privileged engine before each
    // test (schema setup stays privileged; enforcement assertions run on the
    // restricted engine).
    await privileged.executeRaw(`DELETE FROM sources WHERE id <> 'default'`);
    await privileged.executeRaw(`DELETE FROM minion_jobs`);
    await privileged.executeRaw(`DELETE FROM voltmind_cycle_locks`);
  });

  async function seedSource(id: string): Promise<void> {
    const localPath = mkdtempSync(join(tmpdir(), `voltmind-rls-${id}-`));
    await privileged.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived, created_at)
       VALUES ($1, $2, $3, '{}'::jsonb, false, NOW())
       ON CONFLICT (id) DO UPDATE
         SET local_path = EXCLUDED.local_path, config = '{}'::jsonb`,
      [id, id, localPath],
    );
  }

  test('dispatches jobs as restricted role when submitSourceId is set (per-source)', async () => {
    await seedSource('alpha');
    await privileged.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);

    const queue = new MinionQueue(restricted);
    const result = await dispatchPerSource(restricted, queue, {
      repoPath: '/tmp',
      slot: '2026-05-22T12:00:00.000Z',
      timeoutMs: 60_000,
      fanoutMax: 10,
      jsonMode: true,
      emit: () => {},
      log: () => {},
    });

    expect(result.legacy_fallback).toBe(false);
    expect(result.dispatched).toEqual(['alpha']);

    // The insert must actually have landed under the restricted role — this
    // is the whole point of the patch. The row's source_id must match the
    // scope we set (src.id), or an RLS policy would have rejected it.
    const jobs = await privileged.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM minion_jobs WHERE name = 'autopilot-cycle'`,
    );
    expect(jobs.length).toBe(1);
    expect(jobs[0].source_id).toBe('alpha');
  });

  test('legacy fallback (no sources) scopes enqueue to DEFAULT_SOURCE_ID', async () => {
    // No sources rows at all → fan-out drops to the legacy single-job path,
    // which must scope the enqueue to DEFAULT_SOURCE_ID.
    await privileged.executeRaw(`DELETE FROM sources`);

    const queue = new MinionQueue(restricted);
    const result = await dispatchPerSource(restricted, queue, {
      repoPath: '/tmp',
      slot: '2026-05-22T13:00:00.000Z',
      timeoutMs: 60_000,
      fanoutMax: 10,
      jsonMode: true,
      emit: () => {},
      log: () => {},
    });

    expect(result.legacy_fallback).toBe(true);
    // Read back on the PRIVILEGED engine — the restricted role cannot see
    // minion_jobs rows without an installed read scope (RLS fail-closed),
    // so querying it there would report 0 even though the insert landed.
    const jobs = await privileged.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM minion_jobs WHERE name = 'autopilot-cycle'`,
    );
    expect(jobs.length).toBe(1);
    expect(jobs[0].source_id).toBe(DEFAULT_SOURCE_ID);
  });

  test('negative control: raw queue.add WITHOUT submitSourceId fails RLS policy', async () => {
    const queue = new MinionQueue(restricted);
    let err: string | null = null;
    try {
      await queue.add('__rls_neg_control__', { repoPath: '/tmp' }, { queue: 'default' });
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    // If the restricted role truly enforces RLS (it must, per the beforeAll
    // rolbypassrls check), an unscoped insert is rejected. This is the
    // counterfactual that proves the positive case above isn't a false pass.
    expect(err).toContain('row-level security');
  });
});