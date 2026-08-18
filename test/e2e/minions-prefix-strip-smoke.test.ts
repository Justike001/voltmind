/**
 * v0.41 E2E - qualified provider:model reaches the AI gateway transport.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { makeSubagentHandler } from '../../src/core/minions/handlers/subagent.ts';
import {
  __setChatTransportForTests,
  type ChatBlock,
  type ChatResult,
  type ChatOpts,
} from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM subagent_messages');
  await engine.executeRaw('DELETE FROM subagent_tool_executions');
  await engine.executeRaw('DELETE FROM subagent_rate_leases');
  await engine.executeRaw('DELETE FROM minion_jobs');
}, 30_000);

afterEach(() => {
  __setChatTransportForTests(null);
});

describe('v0.41 gateway routing', () => {
  test('qualified provider:model reaches the gateway with the qualified model id', async () => {
    const calls: ChatOpts[] = [];
    __setChatTransportForTests(async (opts): Promise<ChatResult> => {
      calls.push(opts);
      return {
        text: 'ok',
        blocks: [{ type: 'text', text: 'ok' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: opts.model ?? 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      };
    });

    const handler = makeSubagentHandler({
      engine,
      toolRegistry: [],
      maxConcurrent: 100,
      rateLeaseKey: 'k_e2e_prefix',
    });

    const job = await queue.add(
      'subagent',
      { prompt: 'hi', model: 'anthropic:claude-sonnet-4-6' },
      {},
      { allowProtectedSubmit: true },
    );
    const ctx = {
      id: job.id,
      data: { prompt: 'hi', model: 'anthropic:claude-sonnet-4-6' },
      signal: new AbortController().signal,
      shutdownSignal: new AbortController().signal,
      readInbox: async () => [],
      updateTokens: async () => {},
      updateProgress: async () => {},
    } as any;
    await handler(ctx);

    expect(calls.length).toBe(1);
    expect(calls[0]!.model).toBe('anthropic:claude-sonnet-4-6');
  });
});
