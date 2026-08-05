import { createHash } from 'node:crypto';
import type { ExternalFileReferenceV1 } from './external-file-refs.ts';

/**
 * Stable JSON encoding for hashes whose inputs are structured data. Object
 * keys are sorted recursively; array order is retained unless the caller
 * explicitly canonicalizes it first.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

/** Hash only provider-owned source event payload fields. */
export function computeSourcePayloadHash(input: {
  content: string;
  content_type: string;
  evidence_type: string;
}): string {
  return sha256({
    content: input.content,
    content_type: input.content_type,
    evidence_type: input.evidence_type,
  });
}

function fileRefIdentity(ref: ExternalFileReferenceV1): Record<string, unknown> {
  if (ref.provider === 'microsoft') {
    return {
      provider: ref.provider,
      service: ref.service,
      tenant_id: ref.tenant_id,
      drive_id: ref.drive_id,
      item_id: ref.item_id,
      name: ref.name,
      display_path: ref.display_path ?? null,
      relative_path: null,
      file_id: null,
    };
  }
  return {
    provider: ref.provider,
    service: ref.service,
    tenant_id: null,
    drive_id: ref.root_key,
    item_id: ref.file_id ? `id:${ref.file_id}` : `path:${ref.relative_path.toLowerCase()}`,
    name: ref.name,
    display_path: ref.display_path ?? null,
    relative_path: ref.relative_path,
    file_id: ref.file_id ?? null,
  };
}

/**
 * Hash the normalized file-reference projection only. Temporary URLs,
 * occurrences, availability and connector observation metadata are excluded.
 */
export function computeFileRefsProjectionHash(refs: ExternalFileReferenceV1[]): string {
  const identities = refs.map(fileRefIdentity).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  return sha256(identities);
}
