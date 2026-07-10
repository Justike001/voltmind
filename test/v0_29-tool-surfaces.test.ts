/**
 * v0.29 — tool-surface contracts.
 *
 * Verifies two filter contracts that touch the v0.29 ops but live outside
 * the v0.29 source files (in serve-http.ts and brain-allowlist.ts):
 *
 * 1. The retrieval-enrichment batch now keeps `get_recent_transcripts`
 *    visible as a read-only MCP tool. It must not carry localOnly.
 *
 * 2. `buildBrainTools` (subagent registry) surfaces salience, anomalies,
 *    and recent transcript readouts.
 *
 * Both filters are pure-function checks; no DB / engine / network needed.
 */

import { describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { VoltMindConfig } from '../src/core/config.ts';

describe('v0.29 — serve-http localOnly filter', () => {
  // serve-http.ts:745 is the canonical filter expression.
  const mcpVisible = operations.filter(op => !op.localOnly);

  test('get_recent_transcripts is visible in the HTTP MCP tool list', () => {
    const names = mcpVisible.map(o => o.name);
    expect(names).toContain('get_recent_transcripts');
  });

  test('get_recent_salience and find_anomalies stay visible', () => {
    const names = mcpVisible.map(o => o.name);
    expect(names).toContain('get_recent_salience');
    expect(names).toContain('find_anomalies');
  });

  test('get_recent_transcripts does not carry localOnly', () => {
    const op = operations.find(o => o.name === 'get_recent_transcripts');
    expect(op).toBeDefined();
    expect(op!.localOnly).toBeFalsy();
  });

  test('get_recent_salience and find_anomalies do NOT carry localOnly', () => {
    // Read-only ops that subagents need; localOnly would block them from MCP.
    const sal = operations.find(o => o.name === 'get_recent_salience');
    const ano = operations.find(o => o.name === 'find_anomalies');
    expect(sal!.localOnly).toBeFalsy();
    expect(ano!.localOnly).toBeFalsy();
  });

  test('all three v0.29 ops carry scope: read', () => {
    // v0.26.0 contract: every op must annotate scope. Read-only is correct
    // for all three (no DB writes, no fs writes).
    for (const name of ['get_recent_salience', 'find_anomalies', 'get_recent_transcripts']) {
      const op = operations.find(o => o.name === name);
      expect(op!.scope).toBe('read');
    }
  });
});

describe('v0.29 — buildBrainTools subagent surfacing', () => {
  // buildBrainTools doesn't issue any SQL at registry-build time — it only
  // reads `engine.kind` for the put_page namespace-wrap branch. A minimal
  // fake-engine literal keeps the test pure (no PGLite WASM cold-start, no
  // connect/disconnect lifecycle, no test-isolation R3/R4 violations).
  // Cast through `unknown` because the BrainEngine surface is large and
  // we only touch one property.
  const fakeEngine = { kind: 'pglite' } as unknown as BrainEngine;
  const config: VoltMindConfig = { engine: 'pglite' } as VoltMindConfig;

  test('subagent registry includes brain_get_recent_salience', () => {
    const tools = buildBrainTools({ subagentId: 1, engine: fakeEngine, config });
    const names = tools.map(t => t.name);
    expect(names).toContain('brain_get_recent_salience');
  });

  test('subagent registry includes brain_find_anomalies', () => {
    const tools = buildBrainTools({ subagentId: 1, engine: fakeEngine, config });
    const names = tools.map(t => t.name);
    expect(names).toContain('brain_find_anomalies');
  });

  test('subagent registry includes brain_get_recent_transcripts', () => {
    const tools = buildBrainTools({ subagentId: 1, engine: fakeEngine, config });
    const names = tools.map(t => t.name);
    expect(names).toContain('brain_get_recent_transcripts');
  });

  test('the v0.29 ops carry their description verbatim into the registry', () => {
    const tools = buildBrainTools({ subagentId: 1, engine: fakeEngine, config });
    const sal = tools.find(t => t.name === 'brain_get_recent_salience');
    const ano = tools.find(t => t.name === 'brain_find_anomalies');
    const tx = tools.find(t => t.name === 'brain_get_recent_transcripts');
    const opSal = operations.find(o => o.name === 'get_recent_salience');
    const opAno = operations.find(o => o.name === 'find_anomalies');
    const opTx = operations.find(o => o.name === 'get_recent_transcripts');
    expect(sal!.description).toBe(opSal!.description);
    expect(ano!.description).toBe(opAno!.description);
    expect(tx!.description).toBe(opTx!.description);
  });
});
