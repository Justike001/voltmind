import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrations } from '../src/core/migrate.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  // Explicitly isolated in-memory database: this test never opens VOLTMIND_HOME
  // or any on-disk brain while exercising destructive repair DDL.
  await engine.connect({ database_path: undefined });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

test('v121 repairs legacy multimodal columns to canonical halfvec(2048)', async () => {
  await engine.executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding_image');
  await engine.executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding_multimodal');
  await engine.executeRaw('ALTER TABLE content_chunks DROP COLUMN embedding_image');
  await engine.executeRaw('ALTER TABLE content_chunks DROP COLUMN embedding_multimodal');
  await engine.executeRaw('ALTER TABLE content_chunks ADD COLUMN embedding_image halfvec(1024)');
  await engine.executeRaw('ALTER TABLE content_chunks ADD COLUMN embedding_multimodal halfvec(1536)');
  await engine.setConfig('version', '120');

  const result = await runMigrations(engine);
  expect(result).toEqual({ applied: 1, current: 121 });

  const rows = await engine.executeRaw<{ column_name: string; formatted_type: string }>(`
    SELECT a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS formatted_type
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'content_chunks'
       AND a.attname IN ('embedding_image', 'embedding_multimodal')
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY a.attname
  `);
  expect(rows).toEqual([
    { column_name: 'embedding_image', formatted_type: 'halfvec(2048)' },
    { column_name: 'embedding_multimodal', formatted_type: 'halfvec(2048)' },
  ]);
});
