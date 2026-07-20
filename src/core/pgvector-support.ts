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
  const rows = await engine.executeRaw<{ extversion: string | null }>(
    `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
  );
  const version = rows[0]?.extversion ?? null;
  if (pgvectorSupportsHalfvec(version)) return;
  throw new Error(
    `Supabase pgvector ${version ?? 'is not installed'} is incompatible with VoltMind's Qwen 2048d halfvec schema. ` +
    `Install/upgrade extension "vector" to >= 0.7.0, then run init again.`,
  );
}
