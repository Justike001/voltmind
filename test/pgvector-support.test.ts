import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { assertPgvectorHalfvecSupport, pgvectorSupportsHalfvec } from '../src/core/pgvector-support.ts';

describe('pgvector halfvec compatibility gate', () => {
  test('accepts 0.7.0 and newer releases', () => {
    expect(pgvectorSupportsHalfvec('0.7.0')).toBe(true);
    expect(pgvectorSupportsHalfvec('0.8.1')).toBe(true);
    expect(pgvectorSupportsHalfvec('1.0.0')).toBe(true);
  });

  test('rejects missing, malformed, and pre-halfvec releases', () => {
    expect(pgvectorSupportsHalfvec('0.6.2')).toBe(false);
    expect(pgvectorSupportsHalfvec(null)).toBe(false);
    expect(pgvectorSupportsHalfvec('unknown')).toBe(false);
  });

  test('requires the halfvec type and a working 2048d HNSW probe', async () => {
    const calls: string[] = [];
    const engine = {
      kind: 'postgres',
      executeRaw: async (sql: string) => {
        calls.push(sql);
        if (sql.includes('to_regtype')) return [{ extversion: '0.7.0', halfvec_type: 'halfvec' }];
        return [];
      },
    } as unknown as BrainEngine;

    await assertPgvectorHalfvecSupport(engine);
    expect(calls.some(sql => sql.includes('halfvec(2048)'))).toBe(true);
    expect(calls.some(sql => sql.includes('halfvec_cosine_ops'))).toBe(true);
  });

  test('fails closed when the extension version or probe is incompatible', async () => {
    const oldEngine = {
      kind: 'postgres',
      executeRaw: async () => [{ extversion: '0.6.2', halfvec_type: null }],
    } as unknown as BrainEngine;
    await expect(assertPgvectorHalfvecSupport(oldEngine)).rejects.toThrow(/>= 0\.7\.0/);

    const brokenEngine = {
      kind: 'postgres',
      executeRaw: async (sql: string) => {
        if (sql.includes('to_regtype')) return [{ extversion: '0.7.0', halfvec_type: 'halfvec' }];
        throw new Error('operator class unavailable');
      },
    } as unknown as BrainEngine;
    await expect(assertPgvectorHalfvecSupport(brokenEngine)).rejects.toThrow(/halfvec_cosine_ops/);
  });
});
