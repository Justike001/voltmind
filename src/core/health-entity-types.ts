import type { SchemaPackManifest } from './schema-pack/manifest-v1.ts';

/** Legacy coverage scope for callers that have not opted into schema-pack routing. */
export const LEGACY_HEALTH_ENTITY_TYPES = ['person', 'company'] as const;

/**
 * Returns the page types the active pack explicitly declares as graph entities.
 * An empty list is meaningful: the pack opted out of entity coverage.
 */
export function healthEntityTypesFromPack(
  pack: Pick<SchemaPackManifest, 'page_types'>,
): string[] {
  return Array.from(new Set(
    pack.page_types
      .filter((pageType) => pageType.primitive === 'entity')
      .map((pageType) => pageType.name),
  ));
}

/**
 * Builds a safe SQL predicate for the small engine-side health query.
 * `undefined` preserves the legacy scope; an explicit empty list is fail-closed.
 */
export function healthEntityTypeSql(entityTypes?: readonly string[]): string {
  const candidates = entityTypes === undefined ? LEGACY_HEALTH_ENTITY_TYPES : entityTypes;
  const types = Array.from(new Set(candidates.filter((type) => /^[a-z][a-z0-9_-]*$/.test(type))));
  if (types.length === 0) return 'FALSE';
  return `type IN (${types.map((type) => `'${type}'`).join(', ')})`;
}
