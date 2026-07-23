// v0.27.1 follow-up: searchVector column routing — `embedding_image`
// path returns image rows only, default `embedding` path returns text/code
// rows only. Verifies the modality-filter contract that backs the
// `voltmind query --image <path>` flag.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { readContentChunksEmbeddingDim } from '../src/core/embedding-dim-check.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
/**
 * Actual `content_chunks.embedding` column width at runtime. Probed
 * after initSchema, NOT hardcoded — the brain inherits from
 * `~/.voltmind/config.json` (locally) or `DEFAULT_EMBEDDING_DIMENSIONS`
 * (CI fresh-install). Hardcoding 1536 or 1280 makes the test green
 * on one and red on the other; the default model has flipped twice
 * already (OpenAI 3-large=1536 → ZE zembed-1=1280 → Qwen3-VL=2048).
 */
let TEXT_DIM = 0;

beforeAll(async () => {
  // The image column is part of the canonical Qwen 2048d multimodal space.
  // The global preload keeps legacy tests on OpenAI/1536, so configure the
  // schema contract explicitly before this file initializes its engine.
  configureGateway({
    embedding_model: 'qwen-vllm:./models/Qwen3-VL-Embedding-2B',
    embedding_dimensions: 2048,
    env: { ...process.env },
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const probe = await readContentChunksEmbeddingDim(engine);
  if (!probe.exists || probe.dims === null) {
    throw new Error('content_chunks.embedding column missing after initSchema — test environment broken');
  }
  TEXT_DIM = probe.dims;
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/**
 * Build a fake text-column vector at the column's runtime dim. Reads
 * `TEXT_DIM` populated in `beforeAll` from the actual column. Works
 * on any default — 2048 for the company Qwen stack and 1536 for legacy
 * voltmind config from older default) both pass.
 */
function fakeTextDefault(seed: number): Float32Array {
  const n = TEXT_DIM;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (i + seed) / n;
  return out;
}

function fakeImageNative(seed: number): Float32Array {
  const out = new Float32Array(TEXT_DIM);
  for (let i = 0; i < TEXT_DIM; i++) out[i] = (i + seed) / TEXT_DIM;
  return out;
}

async function seedTextPage(slug: string, vec: Float32Array) {
  await engine.putPage(slug, {
    type: 'note',
    title: slug,
    compiled_truth: `body for ${slug}`,
    timeline: '',
  });
  await engine.upsertChunks(slug, [
    {
      chunk_index: 0,
      chunk_text: `body for ${slug}`,
      chunk_source: 'compiled_truth',
      embedding: vec,
      modality: 'text',
    },
  ]);
}

async function seedImagePage(slug: string, vec: Float32Array) {
  await engine.putPage(slug, {
    type: 'image',
    page_kind: 'image',
    title: slug,
    compiled_truth: '',
    timeline: '',
  });
  await engine.upsertChunks(slug, [
    {
      chunk_index: 0,
      chunk_text: slug,
      chunk_source: 'image_asset',
      embedding_image: vec,
      modality: 'image',
    },
  ]);
}

describe('searchVector column routing (v0.27.1)', () => {
  test('default path searches embedding column and returns text rows only', async () => {
    await seedTextPage('notes/text-only', fakeTextDefault(1));
    await seedImagePage('photos/img-only', fakeImageNative(1));

    const out = await engine.searchVector(fakeTextDefault(1), { limit: 10 });
    const slugs = out.map(r => r.slug);
    expect(slugs).toContain('notes/text-only');
    expect(slugs).not.toContain('photos/img-only');
  });

  test('embeddingColumn=embedding_image searches image column and returns image rows only', async () => {
    await seedTextPage('notes/text-only', fakeTextDefault(2));
    await seedImagePage('photos/img-only', fakeImageNative(2));

    const out = await engine.searchVector(fakeImageNative(2), {
      limit: 10,
      embeddingColumn: 'embedding_image',
    });
    const slugs = out.map(r => r.slug);
    expect(slugs).toContain('photos/img-only');
    expect(slugs).not.toContain('notes/text-only');
  });

  test('image-column path scores by cosine and orders nearest first', async () => {
    // Two image pages with different vectors; query nearest the second.
    const vecA = fakeImageNative(0);
    const vecB = new Float32Array(TEXT_DIM);
    for (let i = 0; i < TEXT_DIM; i++) vecB[i] = (i + 100) / TEXT_DIM;

    await seedImagePage('photos/a', vecA);
    await seedImagePage('photos/b', vecB);

    const hits = await engine.searchVector(vecB, {
      limit: 5,
      embeddingColumn: 'embedding_image',
    });
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0].slug).toBe('photos/b');
  });

  test('searchKeyword hides image rows by default (modality filter)', async () => {
    await seedTextPage('notes/keyword', fakeTextDefault(3));
    await seedImagePage('photos/keyword', fakeImageNative(3));
    // Force image chunk_text to overlap with the text chunk's words so the
    // FTS would otherwise match both rows.
    await engine.upsertChunks('photos/keyword', [
      {
        chunk_index: 0,
        chunk_text: 'body for notes/keyword',
        chunk_source: 'image_asset',
        embedding_image: fakeImageNative(3),
        modality: 'image',
      },
    ]);

    const out = await engine.searchKeyword('body', { limit: 10 });
    const slugs = out.map(r => r.slug);
    expect(slugs).toContain('notes/keyword');
    expect(slugs).not.toContain('photos/keyword');
  });
});
