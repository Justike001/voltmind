// Phase 1 integration test — hybridSearch cross-modal routing.
//
// Uses real PGLite + stubbed gateway fetch. Verifies the routing decisions
// from query-intent through hybrid.ts to engine.searchVector with the
// correct embeddingColumn.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';

let engine: PGLiteEngine;

type FetchHandler = (url: string, init: RequestInit) => Promise<Response>;
let fetchHandler: FetchHandler | null = null;
const origFetch = globalThis.fetch;
let fetchUrlsSeen: string[] = [];
let fetchBodiesSeen: any[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // This suite intentionally exercises the legacy dual-column OpenAI +
  // Voyage route, so do not inherit the fresh-brain Qwen3-VL default.
  await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
  await engine.setConfig('embedding_dimensions', '1536');
  process.env.VOLTMIND_EMBEDDING_MODEL = 'openai:text-embedding-3-large';
  process.env.VOLTMIND_EMBEDDING_DIMENSIONS = '1536';
  fetchHandler = null;
  fetchUrlsSeen = [];
  fetchBodiesSeen = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    fetchUrlsSeen.push(u);
    if (init?.body) {
      try { fetchBodiesSeen.push(JSON.parse(init.body as string)); } catch { /* ignore */ }
    }
    if (!fetchHandler) {
      // Return the canonical Qwen vLLM multimodal response by default.
      return new Response(JSON.stringify({
        embeddings: { float: [Array.from({ length: 2048 }, () => 0.1)] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return fetchHandler(u, init ?? {});
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  delete process.env.VOLTMIND_EMBEDDING_MODEL;
  delete process.env.VOLTMIND_EMBEDDING_DIMENSIONS;
  resetGateway();
});

function configureBoth() {
  // Text remains OpenAI in this legacy dual-column contract; image queries
  // use the canonical Qwen3-VL 2048d endpoint.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    base_urls: { 'qwen-vllm': 'http://qwen.test/v1' },
    env: {
      OPENAI_API_KEY: 'test-key',
      VOYAGE_API_KEY: 'voyage-test-key',
    },
  });
}

describe('hybridSearch cross-modal routing (Phase 1 integration)', () => {
  test("explicit crossModal: 'image' calls Qwen multimodal endpoint, NOT OpenAI", async () => {
    configureBoth();
    // Stub the Qwen multimodal endpoint with a deterministic 2048d vector.
    fetchHandler = async (url) => {
      if (url.includes('/v2/embed')) {
        return new Response(JSON.stringify({
          embeddings: { float: [Array.from({ length: 2048 }, () => 0.5)] },
        }), { status: 200 });
      }
      // Fail OpenAI requests loudly so we catch wrong routing.
      throw new Error(`Unexpected fetch to OpenAI: ${url}`);
    };

    // hybridSearch with no rows in DB just returns []; we're testing that the
    // request hits the multimodal endpoint specifically.
    const results = await hybridSearch(engine, 'hackathon stuff', { crossModal: 'image', limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    // Must have called the multimodal endpoint at least once.
    expect(fetchUrlsSeen.some(u => u.includes('/v2/embed'))).toBe(true);
    // Must NOT have called OpenAI embeddings.
    expect(fetchUrlsSeen.some(u => u.includes('api.openai.com') && u.includes('embeddings'))).toBe(false);
  });

  test('explicit crossModal: "image" sends Qwen text input in the canonical body', async () => {
    configureBoth();
    fetchHandler = async (url) => {
      if (url.includes('/v2/embed')) {
        return new Response(JSON.stringify({
          embeddings: { float: [Array.from({ length: 2048 }, () => 0.5)] },
        }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    await hybridSearch(engine, 'any text', { crossModal: 'image', limit: 5 });
    const qwenBody = fetchBodiesSeen.find(b => b?.inputs?.[0]?.content?.[0]?.type === 'text');
    expect(qwenBody).toBeDefined();
    expect(qwenBody.embedding_types).toEqual(['float']);
  });

  test('default crossModal=text query does NOT call Voyage multimodal', async () => {
    configureBoth();
    // Allow text embed to succeed via the default OpenAI fetch handler.
    fetchHandler = async (url) => {
      if (url.includes('/v2/embed')) {
        throw new Error('Unexpected multimodal call for text-modality query');
      }
      // OpenAI text-embedding response shape: {data: [{embedding: [...]}]}
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
        model: 'text-embedding-3-large',
      }), { status: 200 });
    };

    await hybridSearch(engine, 'what is founder mode', { limit: 5 });
    expect(fetchUrlsSeen.some(u => u.includes('/v2/embed'))).toBe(false);
  });

  test("'auto' literal normalizes to undefined (D22-1) — text query still routes text", async () => {
    configureBoth();
    fetchHandler = async (url) => {
      if (url.includes('/v2/embed')) {
        throw new Error('Unexpected multimodal call for auto-text-intent query');
      }
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
        model: 'text-embedding-3-large',
      }), { status: 200 });
    };

    await hybridSearch(engine, 'what is founder mode', { crossModal: 'auto', limit: 5 });
    // Text route — multimodal never called.
    expect(fetchUrlsSeen.some(u => u.includes('/v2/embed'))).toBe(false);
  });

  test('"show me photos from the hackathon" auto-detects to image routing', async () => {
    configureBoth();
    fetchHandler = async (url) => {
      if (url.includes('/v2/embed')) {
        return new Response(JSON.stringify({
          embeddings: { float: [Array.from({ length: 2048 }, () => 0.3)] },
        }), { status: 200 });
      }
      // Don't fail OpenAI here — auto mode might still call text in 'both' fallback.
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
        model: 'text-embedding-3-large',
      }), { status: 200 });
    };

    await hybridSearch(engine, 'show me photos from the hackathon', { limit: 5 });
    // Auto-detection should have fired image routing.
    expect(fetchUrlsSeen.some(u => u.includes('/v2/embed'))).toBe(true);
  });

  test("'both' mode hits BOTH endpoints in parallel", async () => {
    configureBoth();
    let textCalled = 0;
    let qwenCalled = 0;
    fetchHandler = async (url) => {
      if (url.includes('/v2/embed')) {
        qwenCalled++;
        return new Response(JSON.stringify({
          embeddings: { float: [Array.from({ length: 2048 }, () => 0.3)] },
        }), { status: 200 });
      }
      textCalled++;
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
        model: 'text-embedding-3-large',
      }), { status: 200 });
    };

    await hybridSearch(engine, 'anything', { crossModal: 'both', limit: 5 });
    expect(textCalled).toBeGreaterThanOrEqual(1);
    expect(qwenCalled).toBeGreaterThanOrEqual(1);
  });

  test('fail-open: multimodal unconfigured → image-intent query falls back to text', async () => {
    configureGateway({
      // No embedding_multimodal_model set.
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'test-key' },
    });
    fetchHandler = async (url) => {
      if (url.includes('/v2/embed')) {
        throw new Error('Qwen unavailable');
      }
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
        model: 'text-embedding-3-large',
      }), { status: 200 });
    };

    // crossModal: 'image' with no multimodal model → fail-open to text.
    const results = await hybridSearch(engine, 'show me photos', { crossModal: 'image', limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    // Did NOT throw; fell back successfully.
  });
});
