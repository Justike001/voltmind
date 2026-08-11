/**
 * v0.31 Phase 6 — MCP scope correctness on facts ops.
 *
 * Pins:
 *   - extract_facts → write scope
 *   - recall → read scope
 *   - forget_fact → write scope
 *   - All three present in operations[]
 *   - param shapes match the documented contract
 *
 * Serial test (mutates module-scoped engine state via dispatchToolCall +
 * subsequent reads).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('facts MCP ops registration + scope', () => {
  test('extract_facts is registered with write scope', () => {
    const op = operations.find(o => o.name === 'extract_facts');
    expect(op).toBeDefined();
    expect(op!.scope).toBe('write');
    expect(op!.mutating).toBe(true);
    expect(op!.params.turn_text?.required).toBe(true);
    expect(op!.params.session_id).toBeDefined();
  });

  test('recall is registered with read scope', () => {
    const op = operations.find(o => o.name === 'recall');
    expect(op).toBeDefined();
    expect(op!.scope).toBe('read');
    // recall should not be mutating.
    expect(op!.mutating).toBeFalsy();
    expect(op!.params.entity).toBeDefined();
    expect(op!.params.since).toBeDefined();
    expect(op!.params.session_id).toBeDefined();
  });

  test('forget_fact is registered with write scope', () => {
    const op = operations.find(o => o.name === 'forget_fact');
    expect(op).toBeDefined();
    expect(op!.scope).toBe('write');
    expect(op!.mutating).toBe(true);
    expect(op!.params.id?.required).toBe(true);
  });
});

describe('forget_fact dispatch', () => {
  test('forget_fact reaches the registered operation', async () => {
    const r = await dispatchToolCall(engine, 'forget_fact', { id: 99999 }, {
      remote: true, sourceId: 'default',
    });
    expect(r.isError).toBe(true);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.error).toBe('fact_not_found');
  });

  test('forget_fact can mutate an existing fact through MCP', async () => {
    const inserted = await engine.insertFact(
      { fact: 'will be forgotten', kind: 'fact', source: 'test' },
      { source_id: 'default' },
    );
    const r1 = await dispatchToolCall(engine, 'forget_fact', { id: inserted.id }, {
      remote: true, sourceId: 'default',
    });
    expect(r1.isError).not.toBe(true);
  });

  test('fact forget operations cannot cross the caller source boundary', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('other-source', 'Other Source') ON CONFLICT (id) DO NOTHING`,
    );
    const foreign = await engine.insertFact(
      { fact: 'must remain isolated', kind: 'fact', source: 'test' },
      { source_id: 'other-source' },
    );

    const preview = await dispatchToolCall(engine, 'preview_forget_fact', { id: foreign.id }, {
      remote: true,
      sourceId: 'default',
    });
    expect(preview.isError).toBe(true);
    expect(JSON.parse(preview.content[0].text).error).toBe('fact_not_found');

    const legacy = await dispatchToolCall(engine, 'forget_fact', { id: foreign.id }, {
      remote: true,
      sourceId: 'default',
    });
    expect(legacy.isError).toBe(true);
    expect(JSON.parse(legacy.content[0].text).error).toBe('fact_not_found');

    const controlled = await dispatchToolCall(engine, 'apply_forget_fact', {
      id: foreign.id,
      reason: 'unauthorized',
      source_id: 'default',
      citation: 'test request',
      confirm: true,
    }, { remote: true, sourceId: 'default' });
    expect(controlled.isError).toBe(true);
    expect(JSON.parse(controlled.content[0].text).error).toBe('fact_not_found');

    const rows = await engine.executeRaw<{ expired_at: Date | null }>(
      `SELECT expired_at FROM facts WHERE id = $1`,
      [foreign.id],
    );
    expect(rows[0]?.expired_at).toBeNull();
  });
});

describe('extract_facts dispatch (no API key)', () => {
  test('reaches the registered extraction operation', async () => {
    const r = await dispatchToolCall(engine, 'extract_facts', {
      turn_text: 'I am flying to Tokyo Tuesday.',
    }, { remote: true, sourceId: 'default' });
    expect(r.isError).not.toBe(true);
  });
});
