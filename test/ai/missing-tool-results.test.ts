/**
 * Regression harness for `AI_MissingToolResultsError` ("Tool results are
 * missing for tool calls call_0, call_1, call_2") observed against
 * DeepSeek/OpenRouter on multi-parallel-tool-call turns (jobs 3837/3838).
 *
 * The error is thrown by the REAL AI SDK message-validation inside
 * `gateway.chat()` → `generateText()`, so a fake chat transport can't
 * reproduce it. This harness drives the real `createOpenAICompatible`
 * provider against a local mock OpenRouter HTTP server:
 *
 *   - request 1 (no 'tool' role yet): assistant replies with THREE parallel
 *     tool_calls (ids call_0/call_1/call_2) and finish_reason=tool_calls
 *   - request 2 (tool results present): assistant replies with plain text
 *
 * `gateway.toolLoop()` then runs turn 0 (assistant tool-calls) and turn 1
 * (tool results fed back). If the assistant tool-call ids and the
 * tool-result ids don't reconcile, the SDK throws on turn 1 — exactly the
 * production symptom.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { configureGateway, resetGateway, toolLoop } from '../../src/core/ai/gateway.ts';
import type { ChatBlock, ChatMessage, ChatToolDef, ToolLoopReplayState, ToolLoopResult } from '../../src/core/ai/gateway.ts';

let server: Server;
let port: number;
let requestCount = 0;

const MODEL = 'openrouter:deepseek/deepseek-v4-flash-0731';

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || '{}') as { messages?: Array<{ role: string }> };
    requestCount++;
    const hasToolRole = (parsed.messages ?? []).some((m) => m.role === 'tool');
    const payload = hasToolRole
      ? {
          id: 'chatcmpl-2', object: 'chat.completion', model: 'deepseek/deepseek-v4-flash-0731',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done', tool_calls: [] }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 },
        }
      : {
          id: 'chatcmpl-1', object: 'chat.completion', model: 'deepseek/deepseek-v4-flash-0731',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_0', type: 'function', function: { name: 'tool_a', arguments: '{"x":1}' } },
                { id: 'call_1', type: 'function', function: { name: 'tool_b', arguments: '{"y":2}' } },
                { id: 'call_2', type: 'function', function: { name: 'tool_c', arguments: '{"z":3}' } },
              ],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requestCount = 0;
  resetGateway();
  configureGateway({
    chat_model: MODEL,
    base_urls: { openrouter: `http://127.0.0.1:${port}/v1` },
    env: { OPENROUTER_API_KEY: 'sk-test', OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/v1` },
  });
});

const TOOLS: ChatToolDef[] = [
  { name: 'tool_a', description: 'a', inputSchema: { type: 'object', properties: { x: { type: 'number' } } } },
  { name: 'tool_b', description: 'b', inputSchema: { type: 'object', properties: { y: { type: 'number' } } } },
  { name: 'tool_c', description: 'c', inputSchema: { type: 'object', properties: { z: { type: 'number' } } } },
];

function handlers(): Map<string, { execute: (input: unknown, signal: AbortSignal) => Promise<unknown> }> {
  return new Map([
    ['tool_a', { execute: async () => 'a-result' }],
    ['tool_b', { execute: async () => 'b-result' }],
    ['tool_c', { execute: async () => 'c-result' }],
  ]);
}

describe('gatewayToolLoop with parallel tool calls (AI_MissingToolResultsError regression)', () => {
  test('three parallel tool calls reconcile and produce a final text turn', async () => {
    const result: ToolLoopResult = await toolLoop({
      model: MODEL,
      system: 'you are a test agent',
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'run the three tools' }] }],
      tools: TOOLS,
      toolHandlers: handlers(),
      maxTurns: 4,
      maxTokens: 512,
    });
    // Turn 0 must have executed all three tools and received their results
    // back, then turn 1 must have completed without the SDK throwing
    // "Tool results are missing for tool calls call_0, call_1, call_2".
    expect(result.stopReason).toBe('end');
    expect(result.finalText).toBe('done');
    expect(requestCount).toBe(2);
    const toolResultBlocks = result.messages
      .filter((m) => m.role === 'tool')
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    expect(toolResultBlocks.filter((b: any) => b.type === 'tool-result')).toHaveLength(3);
    const assistantToolCalls = result.messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b: any) => b.type === 'tool-call');
    // The assistant tool-call ids and the tool-result ids must reconcile.
    const callIds = assistantToolCalls.map((b: any) => b.toolCallId);
    const resultIds = toolResultBlocks.filter((b: any) => b.type === 'tool-result').map((b: any) => b.toolCallId);
    expect(resultIds.sort()).toEqual(callIds.sort());
  });

  test('resumed history is fully resolved before the next chat (tool messages present)', async () => {
    // Contract guard: the subagent HANDLER reconstructs the 'tool' result
    // messages for prior assistant turns before handing the history to
    // gateway.toolLoop (tool results are not persisted as messages). This test
    // feeds the handler's OUTPUT shape — a fully-resolved history where every
    // assistant tool-call turn is followed by its tool-result message — and
    // asserts the loop drives it through the real AI SDK without throwing
    // "Tool results are missing for tool calls ...".
    const priorMessages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'run the three tools' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call_0', toolName: 'tool_a', input: { x: 1 } },
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'tool_b', input: { y: 2 } },
          { type: 'tool-call', toolCallId: 'call_2', toolName: 'tool_c', input: { z: 3 } },
        ] as ChatBlock[],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'call_0', toolName: 'tool_a', output: { type: 'text', value: 'a-result' } },
          { type: 'tool-result', toolCallId: 'call_1', toolName: 'tool_b', output: { type: 'text', value: 'b-result' } },
          { type: 'tool-result', toolCallId: 'call_2', toolName: 'tool_c', output: { type: 'text', value: 'c-result' } },
        ] as ChatBlock[],
      },
    ];
    const result: ToolLoopResult = await toolLoop({
      model: MODEL,
      system: 'you are a test agent',
      initialMessages: [],
      tools: TOOLS,
      toolHandlers: handlers(),
      maxTurns: 4,
      maxTokens: 512,
      replayState: {
        priorMessages,
        priorTools: new Map(),
        nextTurnIdx: 1,
        nextMessageIdx: 2,
      } as ToolLoopReplayState,
    });
    expect(result.stopReason).toBe('end');
    expect(result.finalText).toBe('done');
  });
});
