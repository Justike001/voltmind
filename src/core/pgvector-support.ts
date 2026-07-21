import type { BrainEngine } from './engine.ts';

/** halfvec and its HNSW operator classes were introduced by pgvector 0.7. */
export function pgvectorSupportsHalfvec(version: string | null | undefined): boolean {
  if (!version) return false;
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || (major === 0 && minor >= 7);
}

/**
 * Fail before schema DDL, rather than surfacing an opaque `halfvec does not
 * exist` error halfway through Supabase bootstrap. PGLite bundles compatible
 * pgvector and therefore has no separately managed extension to inspect.
 */
export async function assertPgvectorHalfvecSupport(engine: BrainEngine): Promise<void> {
  if (engine.kind !== 'postgres') return;
  const rows = await engine.executeRaw<{ extversion: string | null; halfvec_type: string | null }>(
    `SELECT e.extversion, to_regtype('halfvec')::text AS halfvec_type
       FROM pg_extension e
      WHERE e.extname = 'vector'`,
  );
  const version = rows[0]?.extversion ?? null;
  const halfvecType = rows[0]?.halfvec_type ?? null;
  if (!pgvectorSupportsHalfvec(version) || halfvecType === null) {
    throw new Error(
      `Supabase pgvector ${version ?? 'is not installed'} is incompatible with VoltMind's Qwen 2048d halfvec schema. ` +
      `Install/upgrade extension "vector" to >= 0.7.0 so to_regtype('halfvec') is available, then run init again.`,
    );
  }
  try {
    await engine.executeRaw(`
      CREATE TEMP TABLE voltmind_halfvec_probe (embedding halfvec(2048));
      CREATE INDEX voltmind_halfvec_probe_hnsw
        ON voltmind_halfvec_probe USING hnsw (embedding halfvec_cosine_ops);
      DROP TABLE voltmind_halfvec_probe;
    `);
  } catch (error) {
    throw new Error(
      `Supabase pgvector ${version} exposes halfvec but cannot create halfvec(2048) ` +
      `with halfvec_cosine_ops HNSW: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
