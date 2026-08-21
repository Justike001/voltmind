/**
 * test/e2e/autopilot-rls-worker-scope.test.ts
 *
 * Regression test for TODO-RLS-WORKER-1 (v0.42 task C, spec:
 * docs/plans/2026-08-21-autopilot-rls-worker-scope.md).
 *
 * Task B fixed the ENQUEUE side (autopilot passes submitSourceId so the
 * FORCE-RLS minion_jobs INSERT passes under voltmind_restricted). The worker's
 * CONSUME side — claim, stall recovery, timeouts, promote, complete/fail —
 * still ran every queue method via engine.transaction WITHOUT installing a
 * source scope, so under a non-BYPASSRLS role every minion_jobs access was
 * RLS-filtered to 0 rows (verified: claim returned null while the job sat in
 * 'waiting'). This is v0.42 task C.
 *
 * The decision (per the spec's required minimal reproduce): Option A (install
 * admin scope ONCE on the worker outer loop) is impossible — setSourceScope /
 * setSourceReadScope / setAdminSourceScope all SET LOCAL (transaction-scoped)
 * via set_config(..., true); calling any of them outside an explicit
 * `engine.transaction` throws `source_scope_not_applied` (verified). Option B
 * (per-method transaction-local scope) is therefore required, and because the
 * FORCE-RLS WRITE policy matches the SCALAR app.source_id exactly, admin scope
 * alone only enables writes to the first source. Each worker→queue method
 * therefore installs the scoped transaction for the job it touches; claim
 * does a two-hop (admin read to pick the candidate, then narrow the write
 * scalar to that job's source); the cross-source bulk sweeps iterate one
 * scoped pass per source.
 *
 * What this test proves (positive + negative):
 *   - a MinionWorker running on a NON-BYPASSRLS engine (voltmind_e2e_runtime,
 *     provisioned by provisionHttpRuntimeDatabaseUrl) claims a seeded
 *     'waiting' job, runs its handler, and completes it (read back via the
 *     PRIVILEGED engine — the restricted role can't see what it can't scope,
 *     same as task B).
 *   - the bulk sweeps (promoteDelayed / handleTimeouts / handleWallClockTimeouts
 *     / handleStalled) each reach jobs from MULTIPLE sources under the
 *     restricted role (per-source scoped passes).
 *   - negative control: a raw unscoped UPDATE on minion_jobs under the same
 *     restricted role matches 0 rows and leaves the seeded job untouched —
 *     proves the harness actually enforces RLS (no false green).
 *
 * Run: DATABASE_URL=... bun test test/e2e/autopilot-rls-worker-scope.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, provisionHttpRuntimeDatabaseUrl } from './helpers.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E autopilot-rls-worker-scope tests (DATABASE_URL not set)');
}

describeE2E('autopilot worker consume under non-BYPASSRLS role (RLS source scope)', () => {
  let privileged: PostgresEngine;
  let restricted: PostgresEngine;

  beforeAll(async () => {
    // Schema (migrations, FORCE RLS) is prepared on the privileged URL — a
    // superuser is required to enable the policies. The restricted engine
    // then enforces them at runtime.
    privileged = (await setupDB()) as PostgresEngine;
    const restrictedUrl = await provisionHttpRuntimeDatabaseUrl();

    restricted = new PostgresEngine();
    // poolSize forces an instance-owned pool so the restricted engine connects
    // AS the non-BYPASSRLS role (without it, connect() falls back to the
    // module-level privileged connection and the whole test is a false green).
    await restricted.connect({ database_url: restrictedUrl, poolSize: 2 });

    // Confirm the restricted engine's own pool is actually non-BYPASSRLS —
    // otherwise RLS never fires and the negative control below would silently
    // pass, making the positive case meaningless.
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

  async function resetSources(...ids: string[]): Promise<void> {
    await privileged.executeRaw(`DELETE FROM minion_jobs`);
    await privileged.executeRaw(`DELETE FROM sources WHERE id <> 'default'`);
    for (const id of ids) {
      await privileged.executeRaw(
        `INSERT INTO sources (id, name, local_path, config, archived, created_at)
         VALUES ($1, $2, '/tmp', '{}'::jsonb, false, NOW())
         ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
        [id, id],
      );
    }
  }

  /** Seed a waiting job via enqueue-with-submitSourceId (task B pattern). */
  async function seedJob(sourceId: string, overrides: Record<string, unknown> = {}): Promise<{ id: number }> {
    const queue = new MinionQueue(restricted);
    const job = await queue.add(
      'noop',
      { source_id: sourceId, ...overrides },
      { queue: 'default', max_attempts: 1 },
      undefined,
      sourceId,
    );
    return { id: job.id };
  }

  test('worker claims, runs, and completes a seeded waiting job (restricted role)', async () => {
    await resetSources('alpha');
    const { id } = await seedJob('alpha');

    const worker = new MinionWorker(restricted, {
      queue: 'default',
      pollInterval: 40,
      healthCheckInterval: 0,
      lockDuration: 30_000,
    });
    worker.register('noop', async (ctx) => ({ ok: true, id: ctx.id }));
    const startPromise = worker.start();

    // Poll until the job reaches a terminal state (read back PRIVILEGED — the
    // restricted role itself cannot see minion_jobs once its scope narrows).
    let final: string | null = null;
    for (let i = 0; i < 200 && !final; i++) {
      await new Promise((r) => setTimeout(r, 40));
      const rows = await privileged.executeRaw<{ status: string }>(
        `SELECT status FROM minion_jobs WHERE id = ${id}`,
      );
      const st = rows[0]?.status;
      if (st && ['completed', 'failed', 'dead', 'cancelled'].includes(st)) final = st;
    }
    worker.stop();
    await startPromise;

    expect(final).toBe('completed');
    const result = await privileged.executeRaw<{ result: Record<string, unknown> | null }>(
      `SELECT result FROM minion_jobs WHERE id = ${id}`,
    );
    expect((result[0]?.result as { ok?: boolean } | null)?.ok).toBe(true);
  });

  test('promoteDelayed reaches delayed jobs from MULTIPLE sources (restricted role)', async () => {
    await resetSources('alpha', 'beta');
    const queue = new MinionQueue(restricted);
    const j1 = await queue.add('noop', { source_id: 'alpha' }, { queue: 'default', delay: 1 }, undefined, 'alpha');
    const j2 = await queue.add('noop', { source_id: 'beta' }, { queue: 'default', delay: 1 }, undefined, 'beta');
    // Force both delay_until timestamps into the past so the sweep picks them up.
    await privileged.executeRaw(
      `UPDATE minion_jobs SET delay_until = now() - interval '1 second'
       WHERE id IN ($1, $2)`,
      [j1.id, j2.id],
    );
    const promoted = await queue.promoteDelayed();
    // Despite admin scope only granting a scalar write to ONE source, the
    // per-source sweep must promote both. Read back privileged to be sure the
    // restricted role isn't hiding rows it failed to write.
    const waitingRows = await privileged.executeRaw<{ id: number }>(
      `SELECT id FROM minion_jobs WHERE status = 'waiting' AND id IN ($1, $2)`,
      [j1.id, j2.id],
    );
    expect(promoted.length).toBe(2);
    expect(waitingRows.length).toBe(2);
  });

  test('handleTimeouts dead-letters timed-out jobs from MULTIPLE sources (restricted role)', async () => {
    await resetSources('alpha', 'beta');
    const queue = new MinionQueue(restricted);
    const j1 = await seedJob('alpha');
    const j2 = await seedJob('beta');
    await privileged.executeRaw(
      `UPDATE minion_jobs SET status = 'active', timeout_at = now() - interval '1 second',
        lock_until = now() + interval '1 minute'
       WHERE id IN ($1, $2)`,
      [j1.id, j2.id],
    );
    const timed = await queue.handleTimeouts();
    expect(timed.length).toBe(2);
    const deadRows = await privileged.executeRaw<{ id: number }>(
      `SELECT id FROM minion_jobs WHERE status = 'dead' AND error_text = 'timeout exceeded' AND id IN ($1, $2)`,
      [j1.id, j2.id],
    );
    expect(deadRows.length).toBe(2);
  });

  test('handleWallClockTimeouts reaches jobs from MULTIPLE sources (restricted role)', async () => {
    await resetSources('alpha', 'beta');
    const queue = new MinionQueue(restricted);
    const j1 = await seedJob('alpha');
    const j2 = await seedJob('beta');
    await privileged.executeRaw(
      `UPDATE minion_jobs SET status = 'active', started_at = now() - interval '1 hour',
        timeout_at = NULL
       WHERE id IN ($1, $2)`,
      [j1.id, j2.id],
    );
    const wall = await queue.handleWallClockTimeouts(30_000);
    expect(wall.length).toBe(2);
    const deadRows = await privileged.executeRaw<{ id: number }>(
      `SELECT id FROM minion_jobs WHERE status = 'dead' AND error_text = 'wall-clock timeout exceeded' AND id IN ($1, $2)`,
      [j1.id, j2.id],
    );
    expect(deadRows.length).toBe(2);
  });

  test('handleStalled requeues stalled jobs from MULTIPLE sources (restricted role)', async () => {
    await resetSources('alpha', 'beta');
    const queue = new MinionQueue(restricted);
    const j1 = await seedJob('alpha');
    const j2 = await seedJob('beta');
    await privileged.executeRaw(
      `UPDATE minion_jobs SET status = 'active', lock_until = now() - interval '1 minute',
        stalled_counter = 0
       WHERE id IN ($1, $2)`,
      [j1.id, j2.id],
    );
    const stalled = await queue.handleStalled();
    expect(stalled.requeued.length + stalled.dead.length).toBe(2);
    const backRows = await privileged.executeRaw<{ id: number }>(
      `SELECT id FROM minion_jobs WHERE status IN ('waiting', 'dead') AND id IN ($1, $2)`,
      [j1.id, j2.id],
    );
    expect(backRows.length).toBe(2);
  });

  test('negative control: raw unscoped UPDATE matches 0 rows under the restricted role', async () => {
    await resetSources('alpha');
    const { id } = await seedJob('alpha');

    // Raw engine UPDATE WITHOUT any source scope — exactly how every worker→queue
    // method behaved pre-task-C (engine.transaction with no scope). Under the
    // restricted role the FORCE-RLS write policy `source_id = app.source_id`
    // compares NULL = NULL → no rows, leaving the job untouched.
    const rows = await restricted.executeRaw(
      `UPDATE minion_jobs SET status = 'active', lock_token = 'unscoped', updated_at = now()
       WHERE id = $1 AND status = 'waiting' RETURNING id`,
      [id],
    );
    expect(rows.length).toBe(0);
    const st = await privileged.executeRaw<{ status: string }>(
      `SELECT status FROM minion_jobs WHERE id = ${id}`,
    );
    expect(st[0].status).toBe('waiting');
  });
});