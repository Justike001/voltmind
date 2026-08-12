import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { configureGateway } from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

describe('Qwen 2048d schema contract', () => {
  const engine = new PGLiteEngine();

  beforeAll(async () => {
    configureGateway({
      embedding_model: 'qwen-vllm:./models/Qwen3-VL-Embedding-2B',
      embedding_dimensions: 2048,
      env: { ...process.env },
    });
    await engine.connect({ engine: 'pglite' });
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('all semantic storage columns are halfvec(2048)', async () => {
    const rows = await engine.executeRaw<{ table_name: string; column_name: string; formatted: string }>(
      `SELECT c.relname AS table_name, a.attname AS column_name,
              format_type(a.atttypid, a.atttypmod) AS formatted
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN ('content_chunks', 'query_cache', 'facts', 'takes')
          AND a.attname IN ('embedding', 'embedding_image', 'embedding_multimodal')
          AND NOT a.attisdropped
        ORDER BY c.relname, a.attname`,
    );

    expect(rows.map((row) => `${row.table_name}.${row.column_name}:${row.formatted}`)).toEqual([
      'content_chunks.embedding:halfvec(2048)',
      'content_chunks.embedding_image:halfvec(2048)',
      'content_chunks.embedding_multimodal:halfvec(2048)',
      'facts.embedding:halfvec(2048)',
      'query_cache.embedding:halfvec(2048)',
      'takes.embedding:halfvec(2048)',
    ]);
  });

  test('all semantic HNSW indexes use halfvec_cosine_ops', async () => {
    const rows = await engine.executeRaw<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'idx_chunks_embedding',
            'idx_chunks_embedding_image',
            'idx_chunks_embedding_multimodal',
            'idx_facts_embedding_hnsw',
            'idx_query_cache_embedding_hnsw',
            'idx_takes_embedding_hnsw'
          )
        ORDER BY indexname`,
    );

    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.indexdef).toContain('halfvec_cosine_ops');
    }
  });
});
