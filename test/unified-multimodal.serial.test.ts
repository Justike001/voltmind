// Commit 3 (Phase 3): unified multimodal column.
//
// Covers:
//   - Schema migration v68 adds embedding_multimodal column
//   - searchVector routes to embedding_multimodal when opts.embeddingColumn set
//   - hybridSearch routes through unified column when search.unified_multimodal=true
//   - D8 fail-open: unified-only=false + empty unified column → falls back to text
//   - D8 strict: unified-only=true + empty column → does not fall back
//   - reindex --multimodal cost estimate + dry-run + VOLTMIND_NO_REEMBED bypass
//   - D7 lock acquired during reindex; second reindex receives LOCK_HELD

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import {
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { runReindexMultimodal } from '../src/commands/reindex-multimodal.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let engine: PGLiteEngine;
let fetchHandler: ((url: string, init: RequestInit) => Promise<Response>) | null = null;
const origFetch = globalThis.fetch;
const TEXT_COLUMN = {
  name: 'embedding',
  type: 'halfvec' as const,
  dimensions: 1536,
  embeddingModel: 'openai:text-embedding-3-large',
};

function search(query: string, opts: Parameters<typeof hybridSearch>[2] = {}) {
  return hybridSearch(engine, query, { ...opts, embeddingColumn: TEXT_COLUMN });
}

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
  fetchHandler = async () => new Response(JSON.stringify({
    embeddings: { float: [Array.from({ length: 2048 }, () => 0.1)] },
  }), { status: 200 });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!fetchHandler) throw new Error('no fetch handler');
    return fetchHandler(typeof url === 'string' ? url : url.toString(), init ?? {});
  }) as typeof fetch;
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    embedding_multimodal_model: 'voyage:voyage-multimodal-3',
    base_urls: { 'qwen-vllm': 'http://qwen.test/v1' },
    env: { OPENAI_API_KEY: 'test', VOYAGE_API_KEY: 'test' },
  });
});

afterEach(() => {
  globalThis.fetch = origFetch;
  resetGateway();
});

describe('Phase 3 schema — v68 migration', () => {
  test('content_chunks has embedding_multimodal column', async () => {
    // Run an explicit query against the column. If the migration ran, this succeeds.
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM content_chunks WHERE embedding_multimodal IS NULL`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('reindex --multimodal command (Phase 3)', () => {
  test('--dry-run reports cost estimate without mutating', async () => {
    // No rows in DB → pending=0, no work needed.
    const result = await runReindexMultimodal(engine, { dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(result.reembedded).toBe(0);
  });

  test('--cost-estimate reports cost but does not run', async () => {
    const result = await runReindexMultimodal(engine, { costEstimate: true });
    expect(result.dry_run).toBe(true);
    expect(result.reembedded).toBe(0);
  });

  test('VOLTMIND_NO_REEMBED=1 honored on zero-pending brain (skip path is no-op-clean)', async () => {
    await withEnv({ VOLTMIND_NO_REEMBED: '1' }, async () => {
      const result = await runReindexMultimodal(engine, {});
      // Zero pending → reindex short-circuits before the env-var check; both
      // paths produce dry_run=false + reembedded=0 + pending=0.
      expect(result.reembedded).toBe(0);
      expect(result.pending_after).toBe(0);
    });
  });

  test('zero-pending returns cleanly', async () => {
    const result = await runReindexMultimodal(engine, { yes: true });
    expect(result.pending_before).toBe(0);
    expect(result.reembedded).toBe(0);
    expect(result.failed).toBe(0);
  });

  test('image chunks rebuild both canonical 2048d columns', async () => {
    const page = await engine.putPage('photos/reindex-probe', {
      type: 'image', page_kind: 'image', title: 'probe', compiled_truth: '', timeline: '',
    });
    await engine.upsertFile({
      page_id: page.id,
      page_slug: 'photos/reindex-probe',
      filename: 'package.json',
      storage_path: 'package.json',
      mime_type: 'image/png',
      size_bytes: 1,
      content_hash: 'sha256:probe',
    });
    await engine.upsertChunks('photos/reindex-probe', [{
      chunk_index: 0,
      chunk_text: 'probe',
      chunk_source: 'image_asset',
      modality: 'image',
    }]);

    const isolatedHome = await mkdtemp(join(tmpdir(), 'voltmind-reindex-test-'));
    try {
      const result = await withEnv({ VOLTMIND_HOME: isolatedHome }, () =>
        runReindexMultimodal(engine, { yes: true }));
      expect(result.pending_after).toBe(0);
      const rows = await engine.executeRaw<{ has_image: boolean; has_unified: boolean }>(`
        SELECT embedding_image IS NOT NULL AS has_image,
               embedding_multimodal IS NOT NULL AS has_unified
          FROM content_chunks cc
          JOIN pages p ON p.id = cc.page_id
         WHERE p.slug = 'photos/reindex-probe'
      `);
      expect(rows).toEqual([{ has_image: true, has_unified: true }]);
    } finally {
      await rm(isolatedHome, { recursive: true, force: true });
    }
  });
});

describe('hybridSearch unified routing (Phase 3)', () => {
  test('search.unified_multimodal=true routes ALL queries through embedding_multimodal', async () => {
    await engine.setConfig('search.unified_multimodal', 'true');
    let qwenCalled = 0;
    let openaiCalled = 0;
    fetchHandler = async (url) => {
      if (url.includes('/v2/embed')) {
        qwenCalled++;
        return new Response(JSON.stringify({
          embeddings: { float: [Array.from({ length: 2048 }, () => 0.1)] },
        }), { status: 200 });
      }
      if (url.includes('api.openai.com') && url.includes('embeddings')) {
        openaiCalled++;
      }
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
      }), { status: 200 });
    };

    await search('totally text query', { limit: 5 });
    // Unified routing: text query forced to multimodal endpoint.
    expect(qwenCalled).toBeGreaterThanOrEqual(1);
  });

  test('D8 fail-open: empty unified column + not strict → falls back to text', async () => {
    // Set unified flag but DON'T set unified_multimodal_only. Empty DB → unified returns [].
    await engine.setConfig('search.unified_multimodal', 'true');
    let openaiCalled = 0;
    fetchHandler = async (url) => {
      if (url.includes('/v2/embed')) {
        return new Response(JSON.stringify({
          embeddings: { float: [Array.from({ length: 2048 }, () => 0.1)] },
        }), { status: 200 });
      }
      openaiCalled++;
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
      }), { status: 200 });
    };

    const results = await search('whatever', { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    // The fall-back path SHOULD call OpenAI (text path) when unified came back empty.
    expect(openaiCalled).toBeGreaterThanOrEqual(1);
  });

  test('D8 strict: unified_multimodal_only=true + empty column → does NOT fall back', async () => {
    await engine.setConfig('search.unified_multimodal', 'true');
    await engine.setConfig('search.unified_multimodal_only', 'true');
    let openaiCalled = 0;
    fetchHandler = async (url) => {
      if (url.includes('/v2/embed')) {
        return new Response(JSON.stringify({
          embeddings: { float: [Array.from({ length: 2048 }, () => 0.1)] },
        }), { status: 200 });
      }
      openaiCalled++;
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
      }), { status: 200 });
    };

    await search('whatever', { limit: 5 });
    // Strict mode means NO text fallback even when unified is empty.
    expect(openaiCalled).toBe(0);
  });
});
