// search_by_image MCP op trust boundary + canonical 2048d model contract.
//
// Covers:
//   - D18: remote (ctx.remote=true) + image_path is rejected
//   - Local (ctx.remote=false) + image_path is accepted
//   - Missing all three of image_path/url/data is rejected
//   - Multiple of image_path/url/data is rejected
//   - Built-in image retrieval always uses Qwen3-VL's native 2048d space

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operationsByName } from '../src/core/operations.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let tmpRoot: string;

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
  31, 21, 196, 137, 0, 0, 0, 12, 73, 68, 65, 84, 8, 87, 99, 248, 207, 192, 0, 0, 0, 3, 0, 1,
  90, 12, 105, 240, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

type FetchHandler = (url: string, init: RequestInit) => Promise<Response>;
let fetchHandler: FetchHandler | null = null;
let seenRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
const origFetch = globalThis.fetch;

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
  tmpRoot = mkdtempSync(join(tmpdir(), 'voltmind-search-by-image-op-'));
  seenRequests = [];
  fetchHandler = async (url, init) => {
    seenRequests.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return new Response(
    JSON.stringify({
      embeddings: { float: [Array.from({ length: 2048 }, () => 0.1)] },
    }),
    { status: 200 },
    );
  };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!fetchHandler) throw new Error('no fetch handler');
    return fetchHandler(typeof url === 'string' ? url : url.toString(), init ?? {});
  }) as typeof fetch;
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    // A stale legacy override must not change the built-in 2048d column path.
    embedding_multimodal_model: 'voyage:voyage-multimodal-3',
    env: { OPENAI_API_KEY: 'test', VOYAGE_API_KEY: 'test' },
  });
});

afterEach(() => {
  globalThis.fetch = origFetch;
  resetGateway();
});

const op = () => operationsByName.search_by_image;

describe('search_by_image op — D18 remote image_path ban', () => {
  test('rejects image_path when ctx.remote=true', async () => {
    const path = join(tmpRoot, 'test.png');
    writeFileSync(path, PNG_BYTES);
    const err = await op().handler(
      { engine, remote: true, auth: { token: 't', clientId: 'c1', scopes: ['read'] } } as any,
      { image_path: path },
    ).catch((e: any) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('permission_denied');
  });

  test('accepts image_path when ctx.remote=false (local CLI)', async () => {
    const path = join(tmpRoot, 'test.png');
    writeFileSync(path, PNG_BYTES);
    const results = await op().handler(
      { engine, remote: false } as any,
      { image_path: path },
    );
    expect(Array.isArray(results)).toBe(true);
  });
});

describe('search_by_image op — input validation', () => {
  test('rejects missing all three inputs', async () => {
    const err = await op().handler(
      { engine, remote: false } as any,
      {},
    ).catch((e: any) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/image_path|image_url|image_data/);
  });

  test('rejects multiple inputs together', async () => {
    const path = join(tmpRoot, 'test.png');
    writeFileSync(path, PNG_BYTES);
    const err = await op().handler(
      { engine, remote: false } as any,
      { image_path: path, image_data: PNG_BYTES.toString('base64') },
    ).catch((e: any) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/only one of/);
  });
});

describe('search_by_image op — canonical unified model', () => {
  test('uses Qwen3-VL /v2/embed and native 2048d despite a legacy Voyage override', async () => {
    const results = await op().handler(
      { engine, remote: true, auth: { token: 't', clientId: 'client_b', scopes: ['read'] } } as any,
      { image_data: PNG_BYTES.toString('base64') },
    );
    expect(Array.isArray(results)).toBe(true);
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.url).toEndWith('/v2/embed');
    expect(seenRequests[0]?.body.model).toBe('./models/Qwen3-VL-Embedding-2B');
  });
});
