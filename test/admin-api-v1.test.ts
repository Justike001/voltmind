import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MIGRATIONS, LATEST_VERSION } from '../src/core/migrate.ts';
import { adminV1OpenApi, rotateOAuthClient } from '../src/commands/admin-v1.ts';
import { VoltMindOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 30000);

afterAll(async () => engine.disconnect());

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM admin_audit_log');
  await engine.executeRaw('DELETE FROM oauth_tokens');
  await engine.executeRaw('DELETE FROM oauth_clients');
});

describe('Admin API v1 schema and queue projection', () => {
  test('migration v122 is canonical and fresh schema has audit table', async () => {
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(122);
    expect(MIGRATIONS.find(m => m.version === 122)?.name).toBe('admin_api_v1_source_jobs_audit');
    const rows = await engine.executeRaw<{ count: number }>('SELECT count(*)::int count FROM admin_audit_log');
    expect(rows[0].count).toBe(0);
  });

  test('projects snake_case and camelCase job source IDs and filters on the column', async () => {
    const a = await queue.add('sync', { source_id: 'source-a' });
    const b = await queue.add('extract', { sourceId: 'source-b' });
    await queue.add('lint', {});
    expect(a.source_id).toBe('source-a');
    expect(b.source_id).toBe('source-b');
    expect((await queue.getJobs({ sourceId: 'source-a' })).map(j => j.id)).toEqual([a.id]);
    expect((await queue.getJobs({ sourceId: 'source-b' })).map(j => j.id)).toEqual([b.id]);
  });

  test('OpenAPI advertises source, OAuth, jobs, cycles, and audit without secret retrieval', () => {
    const spec = adminV1OpenApi();
    expect(spec.paths['/sources']).toBeDefined();
    expect(spec.paths['/oauth-clients']).toBeDefined();
    expect(spec.paths['/sources/{sourceId}/cycles']).toBeDefined();
    expect(spec.paths['/audit']).toBeDefined();
    expect(spec.paths['/autopilot']).toBeDefined();
    expect(spec.paths['/cycle-profiles']).toBeDefined();
    expect(spec.paths['/jobs/{jobId}']).toBeDefined();
    expect(spec.security).toEqual([{ adminCookie: [] }]);
    expect(spec.paths['/sources'].post.security).toEqual([{ adminCookie: [], csrfToken: [] }]);
    expect(JSON.stringify(spec)).not.toContain('client_secret_hash');
  });

  test('rotates OAuth clients atomically and revokes the old client', async () => {
    const provider = new VoltMindOAuthProvider({ sql: sqlQueryForEngine(engine) });
    const old = await provider.registerClientManual('admin-test', ['client_credentials'], 'read write');
    const replacement = await rotateOAuthClient(engine, old.clientId);
    expect(replacement?.clientId).not.toBe(old.clientId);
    expect(replacement?.clientSecret).toStartWith('voltmind_cs_');
    const rows = await engine.executeRaw<{ client_id: string; deleted_at: Date | null }>(
      'SELECT client_id, deleted_at FROM oauth_clients ORDER BY client_id',
    );
    expect(rows.find(row => row.client_id === old.clientId)?.deleted_at).not.toBeNull();
    expect(rows.find(row => row.client_id === replacement?.clientId)?.deleted_at).toBeNull();
  });
});
