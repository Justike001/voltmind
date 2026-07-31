// Pack-driven eligibility for the opt-in takes LLM bootstrap.
//
// This is intentionally separate from `extractable`, which controls facts
// extraction. A distilled page such as `atom` can be a useful source of
// gradeable beliefs while remaining ineligible for recursive fact extraction.

import type { SchemaPackManifest } from './manifest-v1.ts';

/** Return canonical page type names explicitly enabled for takes bootstrap. */
export function takesBootstrapTypesFromPack(
  pack: Pick<SchemaPackManifest, 'page_types'>,
): Set<string> {
  return new Set(
    pack.page_types
      .filter((pageType) => pageType.takes_bootstrap === true)
      .map((pageType) => pageType.name),
  );
}

/** Test one canonical page type without allocating an intermediate Set. */
export function isTakesBootstrapType(
  pack: Pick<SchemaPackManifest, 'page_types'>,
  type: string,
): boolean {
  return pack.page_types.some(
    (pageType) => pageType.name === type && pageType.takes_bootstrap === true,
  );
}
