import { describe, test, expect } from 'bun:test';
import { getPGLiteSchema, PGLITE_SCHEMA_SQL } from '../../src/core/pglite-schema.ts';
import { getPostgresSchema } from '../../src/core/postgres-engine.ts';

describe('getPGLiteSchema', () => {
  test('default produces company Qwen schema (2048d halfvec)', () => {
    // v0.37 fix wave Lane A.1 + CDX2-1: defaults now track the canonical
    // gateway constants in `ai/defaults.ts` instead of the stale v0.13
    // OpenAI literals (1536 / text-embedding-3-large). Fixes the
    // headline bug where bare `voltmind init --pglite` produced a 1536
    // schema while the ZE default model emitted 1280-dim vectors.
    const sql = getPGLiteSchema();
    expect(sql).toMatch(/halfvec\(2048\)/);
    expect(sql).toMatch(/'qwen-vllm:\.\/models\/Qwen3-VL-Embedding-2B'/);
    expect(sql).not.toMatch(/__EMBEDDING_DIMS__/);
    expect(sql).not.toMatch(/__EMBEDDING_MODEL__/);
  });

  test('Gemini 768d substitution', () => {
    const sql = getPGLiteSchema(768, 'gemini-embedding-001');
    expect(sql).toMatch(/halfvec\(768\)/);
    expect(sql).toMatch(/'gemini-embedding-001'/);
    expect(sql).toMatch(/\('embedding_model', 'gemini-embedding-001'\)/);
    expect(sql).toMatch(/\('embedding_dimensions', '768'\)/);
    expect(sql).not.toMatch(/halfvec\(2048\)/);
  });

  test('Voyage 1024d substitution', () => {
    const sql = getPGLiteSchema(1024, 'voyage-3-large');
    expect(sql).toMatch(/halfvec\(1024\)/);
    expect(sql).toMatch(/'voyage-3-large'/);
    expect(sql).toMatch(/\('embedding_model', 'voyage-3-large'\)/);
    expect(sql).toMatch(/\('embedding_dimensions', '1024'\)/);
    expect(sql).toContain('idx_chunks_embedding ON content_chunks USING hnsw');
  });

  test('2048d keeps a HNSW-indexed halfvec column', () => {
    const sql = getPGLiteSchema(2048, 'voyage-4-large');
    expect(sql).toMatch(/halfvec\(2048\)/);
    expect(sql).toMatch(/'voyage-4-large'/);
    expect(sql).toMatch(/\('embedding_dimensions', '2048'\)/);
    expect(sql).toContain('idx_chunks_embedding ON content_chunks USING hnsw');
  });

  test('PGLITE_SCHEMA_SQL back-compat constant is the default-dim schema', () => {
    expect(PGLITE_SCHEMA_SQL).toBe(getPGLiteSchema());
  });
});

describe('getPostgresSchema', () => {
  test('2048d updates halfvec column and seeded config with HNSW', () => {
    const sql = getPostgresSchema(2048, 'voyage-4-large');
    expect(sql).toMatch(/halfvec\(2048\)/);
    expect(sql).toMatch(/\('embedding_model', 'voyage-4-large'\)/);
    expect(sql).toMatch(/\('embedding_dimensions', '2048'\)/);
    expect(sql).toContain('idx_chunks_embedding ON content_chunks USING hnsw');
  });

  test('escapes configured model before inserting into schema SQL literals', () => {
    const sql = getPostgresSchema(1024, "voyage-weird'quoted");
    expect(sql).toContain("'voyage-weird''quoted'");
    expect(sql).not.toContain("'voyage-weird'quoted'");
  });
});
