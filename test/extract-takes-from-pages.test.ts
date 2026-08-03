import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  CLASSIFIER_SYSTEM,
  extractTakesFromPages,
  holderCandidatesFromPage,
  parseClaimsJson,
} from '../src/core/extract-takes-from-pages.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { takesBootstrapTypesFromPack } from '../src/core/schema-pack/takes-bootstrap.ts';

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
      text: '[{"claim":"The custom pack is authoritative.","kind":"take","holder":"brain","weight":0.8}]',
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:stub',
      providerId: 'test',
    };
  });
}

describe('takes bootstrap prompt and attribution validation', () => {
  test('requires grounded per-claim holders and filters operational metadata', () => {
    const raw = JSON.stringify([
      { claim: 'The strategy should prioritize retention.', kind: 'take', holder: 'brain', weight: 0.82 },
      { claim: 'Revenue will double next year.', kind: 'bet', holder: 'people/alice-example', weight: 0.74 },
      { claim: 'A hallucinated attribution.', kind: 'take', holder: 'companies/ghost-example', weight: 0.8 },
      { claim: 'A legacy system attribution.', kind: 'fact', holder: 'system', weight: 0.9 },
      { claim: 'A missing attribution.', kind: 'take', weight: 0.7 },
      { claim: 'VoltMind created this page from Teams chats only.', kind: 'fact', holder: 'brain', weight: 0.9 },
      { claim: 'The strategy should prioritize retention.', kind: 'take', holder: 'world', weight: 0.9 },
    ]);

    expect(parseClaimsJson(raw, {
      allowedHolders: new Set(['world', 'brain', 'people/alice-example']),
    })).toEqual([
      {
        claim: 'The strategy should prioritize retention.',
        kind: 'take',
        holder: 'brain',
        weight: 0.8,
      },
      {
        claim: 'Revenue will double next year.',
        kind: 'bet',
        holder: 'people/alice-example',
        weight: 0.75,
      },
    ]);
  });

  test('derives canonical entity holder candidates from page text only', () => {
    const holders = holderCandidatesFromPage(
      '[[people/alice-example]] disagreed with [Acme](companies/acme-example). Bob was also mentioned.',
    );

    expect([...holders].sort()).toEqual([
      'brain',
      'companies/acme-example',
      'people/alice-example',
      'world',
    ]);
  });

  test('explicit holder override preserves single-author and legacy model output workflows', () => {
    const result = parseClaimsJson(
      '[{"claim":"The market is overheated.","kind":"take","weight":0.77}]',
      { holderOverride: 'people/alice-example' },
    );

    expect(result).toEqual([{
      claim: 'The market is overheated.',
      kind: 'take',
      holder: 'people/alice-example',
      weight: 0.75,
    }]);
  });

  test('prompt encodes holder-subject separation and provenance exclusion', () => {
    expect(CLASSIFIER_SYSTEM).toContain('WHO believes WHAT');
    expect(CLASSIFIER_SYSTEM).toContain('Never infer the holder from the subject');
    expect(CLASSIFIER_SYSTEM).toContain('allowed_holders');
    expect(CLASSIFIER_SYSTEM).toContain('operational metadata');
  });
});

describe('extractTakesFromPages — schema-pack eligibility', () => {
  test('uses takes_bootstrap independently from facts extractable', async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const custom = await engine.putPage(`research/${suffix}`, {
      title: 'Custom research', type: 'research-brief', compiled_truth: LONG_BODY,
    });
    await engine.putPage(`concepts/${suffix}`, {
      title: 'Legacy-shaped page', type: 'concept', compiled_truth: LONG_BODY,
    });

    const eligiblePageTypes = takesBootstrapTypesFromPack({
      page_types: [
        { name: 'research-brief', extractable: false, takes_bootstrap: true },
        { name: 'concept', extractable: true, takes_bootstrap: false },
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
    const takes = await engine.listTakes({ page_id: custom.id });
    expect(takes).toHaveLength(1);
    expect(takes[0]?.holder).toBe('brain');
  });

  test('reports an empty matching corpus without checking or calling the LLM', async () => {
    let chatCalls = 0;
    installChatStub(() => { chatCalls++; });

    const result = await extractTakesFromPages(engine, {
      bootstrapEnabled: true,
      sourceIdFilter: 'default',
      packIdentity: 'custom@1.0.0+deadbeef',
      eligiblePageTypes: new Set(['type-with-no-pages']),
    });

    expect(result).toMatchObject({
      pages_scanned: 0,
      no_op_reason: 'no_matching_pages',
      source_id: 'default',
      pack_identity: 'custom@1.0.0+deadbeef',
      eligible_page_types: ['type-with-no-pages'],
    });
    expect(chatCalls).toBe(0);
  });

  test('reports pack load failure as a distinct fail-closed state', async () => {
    let chatCalls = 0;
    installChatStub(() => { chatCalls++; });

    const result = await extractTakesFromPages(engine, {
      bootstrapEnabled: true,
      eligiblePageTypes: new Set(),
      packLoadError: 'unknown schema pack: missing',
    });

    expect(result).toMatchObject({ no_op_reason: 'pack_load_failed', pack_load_error: 'unknown schema pack: missing' });
    expect(chatCalls).toBe(0);
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
