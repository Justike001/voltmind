/**
 * P2 CLI runtime-unfreeze regression.
 *
 * This test exercises the real PGLite runtime: the public P2 names must stay available at the
 * CLI gate, and P2.2's deterministic code-index and frontmatter-reindex
 * paths must remain usable without an LLM, network, or Minion worker.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { findCodeDef } from '../src/commands/code-def.ts';
import { findCodeRefs } from '../src/commands/code-refs.ts';
import { runReindexFrontmatter } from '../src/commands/reindex-frontmatter.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('P2 runtime unfreeze', () => {
  test('P2.2 code queries and frontmatter reindex execute against an empty local PGLite brain', async () => {
    expect(await findCodeDef(engine, 'not_a_real_symbol')).toEqual([]);
    expect(await findCodeRefs(engine, 'not_a_real_symbol')).toEqual([]);
    expect(await engine.getCallersOf('not_a_real_symbol', { allSources: true })).toEqual([]);
    expect(await engine.getCalleesOf('not_a_real_symbol', { allSources: true })).toEqual([]);

    const frontmatter = await runReindexFrontmatter(engine, { dryRun: true, json: true });
    expect(frontmatter.status).toBe('dry_run');
    expect(frontmatter.examined).toBe(0);
  });
});
