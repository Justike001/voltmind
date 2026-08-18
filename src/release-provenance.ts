import { VERSION } from './version.ts';

/**
 * Release builds replace this development marker with an exact commit-bound
 * manifest before compiling the Host binary.
 */
export const RELEASE_PROVENANCE = {
  schema_version: 1,
  product: 'VoltMind',
  version: VERSION,
  source_commit: 'development',
  admin_content_sha256: 'development',
} as const;
