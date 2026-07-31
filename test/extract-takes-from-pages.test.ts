import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractTakesFromPages } from '../src/core/extract-takes-from-pages.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { extractableTypesFromPack } from '../src/core/schema-pack/extractable.ts';

let engine: PGLiteEngine;

const LONG_BODY = 'This is a substantive, gradeable strategic observation. '.repeat(8);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
});

function installChatStub(onCall: () => void): void {
  __setChatTransportForTests(async (): Promise<ChatResult> => {
    onCall();
    return {
      text: '[{"claim":"The custom pack is authoritative.","kind":"take","weight":0.8}]',
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:stub',
      providerId: 'test',
    };
  });
}

describe('extractTakesFromPages — schema-pack eligibility', () => {
  test('extracts a custom extractable type and ignores retired legacy types', async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const custom = await engine.putPage(`research/${suffix}`, {
      title: 'Custom research', type: 'research-brief', compiled_truth: LONG_BODY,
    });
    await engine.putPage(`concepts/${suffix}`, {
      title: 'Legacy-shaped page', type: 'concept', compiled_truth: LONG_BODY,
    });

    const eligiblePageTypes = extractableTypesFromPack({
      page_types: [
        { name: 'research-brief', extractable: true },
        { name: 'concept', extractable: false },
      ],
    } as never);
    let chatCalls = 0;
    installChatStub(() => { chatCalls++; });

    const result = await extractTakesFromPages(engine, {
      bootstrapEnabled: true,
      eligiblePageTypes,
      maxPages: 10,
    });

    expect(result.pages_scanned).toBe(1);
    expect(result.claims_extracted).toBe(1);
    expect(chatCalls).toBe(1);
    expect(await engine.listTakes({ page_id: custom.id })).toHaveLength(1);
  });

  test('an empty pack eligibility set makes no LLM call', async () => {
    let chatCalls = 0;
    installChatStub(() => { chatCalls++; });

    const result = await extractTakesFromPages(engine, {
      bootstrapEnabled: true,
      eligiblePageTypes: new Set(),
    });

    expect(result).toMatchObject({ pages_scanned: 0, claims_extracted: 0, llm_unavailable: false });
    expect(chatCalls).toBe(0);
  });
});
