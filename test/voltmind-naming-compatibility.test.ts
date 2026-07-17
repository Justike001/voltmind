import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

describe('v107 VoltMind naming finalization', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('leaves only the VoltMind lock table', async () => {
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM voltmind_cycle_locks WHERE id = 'compat-lock'`,
    );
    expect(rows).toEqual([]);
    const old = await engine.executeRaw<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relname = 'gbrain_cycle_locks'`,
    );
    expect(old).toEqual([]);
  });

  test('persists the VoltMind stable tool-call ID', async () => {
    const job = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'active', '{}'::jsonb, 'default', 0, now())
       RETURNING id`,
    );
    const id = '01987654-3210-7000-8000-000000000106';
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, ordinal, voltmind_tool_use_id)
       VALUES ($1, 0, 'tool-106', 'search', '{}'::jsonb, 'pending', 0, $2::uuid)`,
      [job[0].id, id],
    );
    const rows = await engine.executeRaw<{
      voltmind_tool_use_id: string;
    }>(
      `SELECT voltmind_tool_use_id::text
         FROM subagent_tool_executions
        WHERE job_id = $1`,
      [job[0].id],
    );
    expect(rows).toEqual([{ voltmind_tool_use_id: id }]);
    const oldColumn = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'subagent_tool_executions' AND column_name = 'gbrain_tool_use_id'`,
    );
    expect(oldColumn).toEqual([]);
  });
});
