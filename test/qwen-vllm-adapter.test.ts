import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __setRerankTransportForTests,
  configureGateway,
  embedMultimodal,
  rerank,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { AIConfigError } from '../src/core/ai/errors.ts';

const EMBED_MODEL = 'qwen-vllm:./models/Qwen3-VL-Embedding-2B';
const RERANK_MODEL = 'qwen-vllm-reranker:Qwen3-Reranker-4B';
const originalFetch = globalThis.fetch;

function vector(dims = 2048): number[] {
  return Array.from({ length: dims }, (_, index) => index / 1000);
}

beforeEach(() => {
  globalThis.fetch = (async () => {
    throw new Error('fetch called without a test handler');
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __setRerankTransportForTests(null);
  resetGateway();
});

describe('company Qwen vLLM adapters', () => {
  test('uses /v2/embed with Cohere input shape and native 2048d output', async () => {
    configureGateway({
      embedding_model: EMBED_MODEL,
      embedding_dimensions: 2048,
      base_urls: { 'qwen-vllm': 'http://embed.internal:8000/v1' },
      env: {},
    });
    let url = '';
    let body: any;
    globalThis.fetch = (async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ embeddings: { float: [vector(), vector()] } }), { status: 200 });
    }) as typeof fetch;

    const result = await embedMultimodal([
      { kind: 'text', text: 'internal document' },
      { kind: 'image_base64', mime: 'image/png', data: 'pixel' },
    ]);

    expect(url).toBe('http://embed.internal:8000/v2/embed');
    expect(result.map(row => row.length)).toEqual([2048, 2048]);
    expect(body).toEqual({
      model: './models/Qwen3-VL-Embedding-2B',
      inputs: [
        { content: [{ type: 'text', text: 'internal document' }] },
        { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,pixel' } }] },
      ],
      embedding_types: ['float'],
    });
    expect(body.input_type).toBeUndefined();
    expect(body.output_dimension).toBeUndefined();
  });

  test('rejects a non-native multimodal dimension before storage', async () => {
    configureGateway({
      embedding_model: EMBED_MODEL,
      embedding_dimensions: 2048,
      base_urls: { 'qwen-vllm': 'http://embed.internal:8000/v1' },
      env: {},
    });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ embeddings: { float: [vector(1024)] } }), { status: 200 })) as unknown as typeof fetch;

    await expect(embedMultimodal([{ kind: 'text', text: 'wrong width' }]))
      .rejects.toBeInstanceOf(AIConfigError);
  });

  test('uses the internal reranker endpoint and vLLM response shape', async () => {
    configureGateway({
      reranker_model: RERANK_MODEL,
      base_urls: { 'qwen-vllm-reranker': 'http://rerank.internal:8003/v1' },
      env: {},
    });
    let url = '';
    let body: any;
    __setRerankTransportForTests(async (input, init) => {
      url = input;
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        results: [{ index: 1, relevance_score: 0.91 }, { index: 0, relevance_score: 0.2 }],
      }), { status: 200 });
    });

    const result = await rerank({ query: 'internal retrieval', documents: ['unrelated', 'matching'] });

    expect(url).toBe('http://rerank.internal:8003/v1/rerank');
    expect(body).toEqual({
      model: 'Qwen3-Reranker-4B',
      query: 'internal retrieval',
      documents: ['unrelated', 'matching'],
    });
    expect(result).toEqual([{ index: 1, relevanceScore: 0.91 }, { index: 0, relevanceScore: 0.2 }]);
  });
});
