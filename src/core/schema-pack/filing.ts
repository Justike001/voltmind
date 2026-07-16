import { loadConfig } from '../config.ts';
import { loadActivePack } from './load-active.ts';
import type { SchemaPackManifest } from './manifest-v1.ts';

/** Return a normalized directory declared for a semantic filing kind. */
export function filingDirectoryForKind(
  pack: Pick<SchemaPackManifest, 'filing_rules'>,
  kind: string,
): string | null {
  const directory = pack.filing_rules.find(rule => rule.kind === kind)?.directory;
  if (!directory) return null;
  const normalized = directory.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  return normalized ? `${normalized}/` : null;
}

/**
 * Resolve a filing directory through the same active-pack boundary as every
 * other schema decision. There is intentionally no hardcoded fallback:
 * callers must skip a durable write when their pack does not authorize it.
 */
export async function resolveActiveFilingDirectory(
  kind: string,
  sourceId: string,
): Promise<string | null> {
  const pack = await loadActivePack({
    cfg: loadConfig(),
    remote: false,
    sourceId,
  });
  return filingDirectoryForKind(pack.manifest, kind);
}
