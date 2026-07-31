/**
 * External cloud and shared-filesystem references.
 *
 * These rows identify SharePoint/OneDrive items and mapped shared-drive files
 * without copying the file into VoltMind. Provider item/file IDs are stable
 * across path and display-name changes; path-only filesystem references are
 * explicitly weaker and use a shared logical root plus relative path.
 */

import type { BrainEngine } from './engine.ts';

export type ExternalFileProvider = 'microsoft' | 'filesystem';
export type ExternalFileService = 'sharepoint' | 'onedrive' | 'raidrive';
export type ExternalFileAvailability = 'accessible' | 'denied' | 'missing' | 'unverified';
export type ExternalFilePlatform = 'teams' | 'outlook';
export type ExternalFileRelation = 'attachment' | 'inline_link' | 'mentioned' | 'materialized_as';

export interface ExternalFileOccurrence {
  platform: ExternalFilePlatform;
  relation: Exclude<ExternalFileRelation, 'materialized_as'>;
  conversation_id: string;
  message_id: string;
  source_uri: string;
}

interface ExternalFileReferenceBaseV1 {
  schema_version: 1;
  name: string;
  display_path?: string;
  mime_type?: string;
  size_bytes?: number;
  e_tag?: string;
  c_tag?: string;
  last_modified_at?: string;
  availability?: ExternalFileAvailability;
  occurrence?: ExternalFileOccurrence;
}

export interface MicrosoftExternalFileReferenceV1 extends ExternalFileReferenceBaseV1 {
  provider: 'microsoft';
  service: 'sharepoint' | 'onedrive';
  tenant_id: string;
  drive_id: string;
  item_id: string;
  web_url: string;
}

export interface FilesystemExternalFileReferenceV1 extends ExternalFileReferenceBaseV1 {
  provider: 'filesystem';
  service: 'raidrive';
  /** Stable logical root shared by workstations, e.g. synology-public. */
  root_key: string;
  /** Path below the root; never includes a drive letter or UNC host. */
  relative_path: string;
  /** Optional SMB/provider identity. Without it, identity is path-based. */
  file_id?: string;
  /**
   * Deprecated machine-specific observation accepted from older clients.
   * It is never part of identity; new thin clients resolve paths locally.
   */
  open_path?: string;
}

export type ExternalFileReferenceV1 =
  | MicrosoftExternalFileReferenceV1
  | FilesystemExternalFileReferenceV1;

export interface ExternalFileReferenceSummary {
  id: number;
  provider: ExternalFileProvider;
  service: ExternalFileService;
  name: string;
  display_path: string | null;
  web_url: string | null;
  root_key: string | null;
  relative_path: string | null;
  open_path: string | null;
  file_id: string | null;
  mime_type: string | null;
  e_tag: string | null;
  availability: ExternalFileAvailability;
  materialized_page_slug: string | null;
  materialized_etag: string | null;
  materialized_stale?: boolean;
}

const MAX_REFS_PER_EVENT = 100;
const MAX_FIELD_LENGTH = 2048;
const AUTH_QUERY_PARAM = /(?:^|[?&])(access_token|token|sig|signature|x-amz-|se=|sp=|sv=|oauth_token)=/i;

function nonEmpty(value: unknown, field: string, max = MAX_FIELD_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`file_refs.${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function optionalString(value: unknown, field: string, max = MAX_FIELD_LENGTH): string | undefined {
  if (value === undefined || value === null) return undefined;
  return nonEmpty(value, field, max);
}

function normalizedRelativePath(value: unknown, index: number): string {
  const raw = nonEmpty(value, `file_refs[${index}].relative_path`, 2048).replace(/\\/g, '/');
  if (/^[a-z]:/i.test(raw) || raw.startsWith('//')) {
    throw new Error(`file_refs[${index}].relative_path must be relative to root_key`);
  }
  const segments = raw.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`file_refs[${index}].relative_path must not contain traversal segments`);
  }
  return segments.join('/');
}

function normalizedOpenPath(value: unknown, index: number): string {
  const path = nonEmpty(value, `file_refs[${index}].open_path`, 4096);
  if (!/^[a-z]:[\\/]/i.test(path) && !/^\\\\[^\\]+\\[^\\]+/.test(path)) {
    throw new Error(`file_refs[${index}].open_path must be an absolute drive or UNC path`);
  }
  return path;
}

/** Validate and canonicalize untrusted connector input. */
export function normalizeExternalFileRefs(input: unknown): ExternalFileReferenceV1[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error('file_refs must be an array');
  if (input.length > MAX_REFS_PER_EVENT) throw new Error(`file_refs may contain at most ${MAX_REFS_PER_EVENT} items`);

  return input.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`file_refs[${index}] must be an object`);
    }
    const r = raw as Record<string, unknown>;
    if (r.schema_version !== 1) throw new Error(`file_refs[${index}].schema_version must be 1`);
    if (r.provider !== 'microsoft' && r.provider !== 'filesystem') {
      throw new Error(`file_refs[${index}].provider must be microsoft or filesystem`);
    }
    const occurrence = r.occurrence;
    let normalizedOccurrence: ExternalFileOccurrence | undefined;
    if (occurrence !== undefined) {
      if (!occurrence || typeof occurrence !== 'object' || Array.isArray(occurrence)) {
        throw new Error(`file_refs[${index}].occurrence must be an object`);
      }
      const o = occurrence as Record<string, unknown>;
      if (o.platform !== 'teams' && o.platform !== 'outlook') throw new Error(`file_refs[${index}].occurrence.platform is invalid`);
      if (o.relation !== 'attachment' && o.relation !== 'inline_link' && o.relation !== 'mentioned') {
        throw new Error(`file_refs[${index}].occurrence.relation is invalid`);
      }
      normalizedOccurrence = {
        platform: o.platform,
        relation: o.relation,
        conversation_id: nonEmpty(o.conversation_id, `file_refs[${index}].occurrence.conversation_id`, 512),
        message_id: nonEmpty(o.message_id, `file_refs[${index}].occurrence.message_id`, 512),
        source_uri: nonEmpty(o.source_uri, `file_refs[${index}].occurrence.source_uri`),
      };
    }
    const size = r.size_bytes;
    if (size !== undefined && (!Number.isSafeInteger(size) || (size as number) < 0)) {
      throw new Error(`file_refs[${index}].size_bytes must be a non-negative safe integer`);
    }
    if (r.availability !== undefined && r.availability !== 'accessible' && r.availability !== 'denied'
      && r.availability !== 'missing' && r.availability !== 'unverified') {
      throw new Error(`file_refs[${index}].availability is invalid`);
    }
    const lastModified = optionalString(r.last_modified_at, `file_refs[${index}].last_modified_at`, 64);
    if (lastModified !== undefined && !Number.isFinite(Date.parse(lastModified))) {
      throw new Error(`file_refs[${index}].last_modified_at must be an ISO timestamp`);
    }
    const common = {
      schema_version: 1,
      name: nonEmpty(r.name, `file_refs[${index}].name`, 1024),
      display_path: optionalString(r.display_path, `file_refs[${index}].display_path`, 2048),
      mime_type: optionalString(r.mime_type, `file_refs[${index}].mime_type`, 256),
      size_bytes: size as number | undefined,
      e_tag: optionalString(r.e_tag, `file_refs[${index}].e_tag`, 512),
      c_tag: optionalString(r.c_tag, `file_refs[${index}].c_tag`, 512),
      last_modified_at: lastModified,
      availability: r.availability === undefined ? 'unverified' : r.availability as ExternalFileAvailability,
      occurrence: normalizedOccurrence,
    };
    if (r.provider === 'filesystem') {
      if (r.service !== 'raidrive') throw new Error(`file_refs[${index}].service must be raidrive for filesystem refs`);
      const rootKey = nonEmpty(r.root_key, `file_refs[${index}].root_key`, 128).toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(rootKey)) {
        throw new Error(`file_refs[${index}].root_key must use lowercase letters, digits, dot, underscore, or hyphen`);
      }
      return {
        ...common,
        schema_version: 1,
        provider: 'filesystem',
        service: 'raidrive',
        root_key: rootKey,
        relative_path: normalizedRelativePath(r.relative_path, index),
        file_id: optionalString(r.file_id, `file_refs[${index}].file_id`, 512),
        open_path: r.open_path === undefined ? undefined : normalizedOpenPath(r.open_path, index),
      };
    }
    if (r.service !== 'sharepoint' && r.service !== 'onedrive') {
      throw new Error(`file_refs[${index}].service must be sharepoint or onedrive for Microsoft refs`);
    }
    const webUrl = nonEmpty(r.web_url, `file_refs[${index}].web_url`);
    let parsed: URL;
    try {
      parsed = new URL(webUrl);
    } catch {
      throw new Error(`file_refs[${index}].web_url must be an absolute URL`);
    }
    if (parsed.protocol !== 'https:') throw new Error(`file_refs[${index}].web_url must use https`);
    if (AUTH_QUERY_PARAM.test(parsed.search)) {
      throw new Error(`file_refs[${index}].web_url must not contain access or signature query parameters`);
    }
    return {
      ...common,
      schema_version: 1,
      provider: 'microsoft',
      service: r.service,
      tenant_id: nonEmpty(r.tenant_id, `file_refs[${index}].tenant_id`, 512),
      drive_id: nonEmpty(r.drive_id, `file_refs[${index}].drive_id`, 512),
      item_id: nonEmpty(r.item_id, `file_refs[${index}].item_id`, 512),
      web_url: parsed.toString(),
    };
  });
}

/** Rehydrate the compact frontmatter projection back into the V1 shape. */
export function normalizePersistedExternalFileRefs(input: unknown): ExternalFileReferenceV1[] {
  if (!Array.isArray(input)) return [];
  const candidates = input.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const record = raw as Record<string, unknown>;
    return {
      ...record,
      schema_version: record.schema_version ?? 1,
      provider: record.provider ?? 'microsoft',
      availability: record.availability ?? 'unverified',
    };
  });
  return normalizeExternalFileRefs(candidates);
}

export function externalFileIdentity(ref: ExternalFileReferenceV1, sourceId: string): string {
  if (ref.provider === 'microsoft') return `${sourceId}:${ref.tenant_id}:${ref.drive_id}:${ref.item_id}`;
  return `${sourceId}:filesystem:${ref.root_key}:${ref.file_id ? `id:${ref.file_id}` : `path:${ref.relative_path.toLowerCase()}`}`;
}

export function externalFileLogicalUri(ref: ExternalFileReferenceV1): string {
  if (ref.provider === 'microsoft') return ref.web_url;
  const path = ref.relative_path.split('/').map(segment => encodeURIComponent(segment)).join('/');
  return `voltmind-file://${encodeURIComponent(ref.root_key)}/${path}`;
}

/** Markdown projection deliberately contains only human-searchable fields. */
export function renderExternalFileRefs(refs: ExternalFileReferenceV1[]): string {
  if (refs.length === 0) return '';
  const lines = [
    '<!-- voltmind:file-refs:begin -->',
    '## Referenced files',
    '',
    ...refs.map((ref) => ref.provider === 'microsoft'
      ? `- [${ref.name}](${ref.web_url})${ref.display_path ? ` — \`${ref.display_path}\`` : ''}`
      : `- ${ref.name} — \`${ref.root_key}:/${ref.relative_path}\``),
    '<!-- voltmind:file-refs:end -->',
  ];
  return `\n\n${lines.join('\n')}\n`;
}

/** Replace only the generated block; user-authored content remains untouched. */
export function withExternalFileRefsProjection(content: string, refs: ExternalFileReferenceV1[]): string {
  const block = renderExternalFileRefs(refs);
  const begin = '<!-- voltmind:file-refs:begin -->';
  const end = '<!-- voltmind:file-refs:end -->';
  const start = content.indexOf(begin);
  const finish = content.indexOf(end);
  if (!block) {
    if (start >= 0 && finish >= start) {
      return `${content.slice(0, start).replace(/\n{3,}$/g, '\n\n')}${content.slice(finish + end.length).replace(/^\n{3,}/g, '\n\n')}`;
    }
    return content;
  }
  if (start >= 0 && finish >= start) {
    const before = content.slice(0, start).replace(/\n+$/g, '');
    const after = content.slice(finish + end.length).replace(/^\n+/g, '');
    return `${before}${block}${after}`;
  }
  return `${content.trimEnd()}${block}`;
}

export function fileRefsFrontmatter(refs: ExternalFileReferenceV1[]): Record<string, unknown> {
  return {
    file_refs_version: 1,
    file_refs: refs.map((ref) => ref.provider === 'microsoft'
      ? {
          provider: ref.provider,
          service: ref.service,
          tenant_id: ref.tenant_id,
          drive_id: ref.drive_id,
          item_id: ref.item_id,
          name: ref.name,
          display_path: ref.display_path ?? null,
          web_url: ref.web_url,
          mime_type: ref.mime_type ?? null,
          e_tag: ref.e_tag ?? null,
          last_modified_at: ref.last_modified_at ?? null,
          availability: ref.availability ?? 'unverified',
        }
      : {
          provider: ref.provider,
          service: ref.service,
          root_key: ref.root_key,
          relative_path: ref.relative_path,
          file_id: ref.file_id ?? null,
          name: ref.name,
          display_path: ref.display_path ?? ref.relative_path,
          mime_type: ref.mime_type ?? null,
          last_modified_at: ref.last_modified_at ?? null,
          availability: ref.availability ?? 'unverified',
        }),
  };
}

const PAGE_METADATA_KEYS = new Set(['platform', 'conversation_id', 'message_id', 'event_id', 'event_version', 'occurred_at']);

export function normalizePageMetadata(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!PAGE_METADATA_KEYS.has(key)) continue;
    if (typeof value !== 'string' || value.length > 1024) {
      throw new Error(`page_metadata.${key} must be a string of at most 1024 characters`);
    }
    output[key] = value;
  }
  return output;
}

/** Upsert refs and their occurrence rows inside the caller's transaction. */
export async function persistExternalFileRefs(
  tx: BrainEngine,
  slug: string,
  sourceId: string,
  refs: ExternalFileReferenceV1[],
): Promise<void> {
  if (refs.length === 0) return;
  const pageRows = await tx.executeRaw<{ id: number }>(
    'SELECT id FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL LIMIT 1',
    [sourceId, slug],
  );
  const pageId = pageRows[0]?.id;
  if (pageId === undefined) throw new Error(`cannot attach file refs: page '${slug}' was not stored`);
  for (const ref of refs) {
    const isMicrosoft = ref.provider === 'microsoft';
    const tenantId = isMicrosoft ? ref.tenant_id : 'filesystem';
    const driveId = isMicrosoft ? ref.drive_id : ref.root_key;
    const itemId = isMicrosoft
      ? ref.item_id
      : ref.file_id ? `id:${ref.file_id}` : `path:${ref.relative_path.toLowerCase()}`;
    const refRows = await tx.executeRaw<{ id: number }>(
      `INSERT INTO external_file_refs
        (source_id, provider, service, tenant_id, drive_id, item_id, name, display_path, web_url,
         root_key, relative_path, open_path, file_id, mime_type, size_bytes, e_tag, c_tag,
         last_modified_at, availability, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, now(), now())
       ON CONFLICT (source_id, provider, tenant_id, drive_id, item_id)
       DO UPDATE SET name = EXCLUDED.name, display_path = EXCLUDED.display_path, web_url = EXCLUDED.web_url,
         root_key = EXCLUDED.root_key, relative_path = EXCLUDED.relative_path,
         open_path = COALESCE(EXCLUDED.open_path, external_file_refs.open_path), file_id = EXCLUDED.file_id,
         mime_type = EXCLUDED.mime_type, size_bytes = EXCLUDED.size_bytes, e_tag = EXCLUDED.e_tag,
         c_tag = EXCLUDED.c_tag, last_modified_at = EXCLUDED.last_modified_at,
         availability = EXCLUDED.availability,
         materialized_stale = CASE
           WHEN external_file_refs.materialized_etag IS NOT NULL
             AND EXCLUDED.e_tag IS NOT NULL
             AND external_file_refs.materialized_etag IS DISTINCT FROM EXCLUDED.e_tag
           THEN true ELSE external_file_refs.materialized_stale END,
         last_seen_at = now()
       RETURNING id`,
      [sourceId, ref.provider, ref.service, tenantId, driveId, itemId, ref.name,
        ref.display_path ?? (isMicrosoft ? null : ref.relative_path), isMicrosoft ? ref.web_url : null,
        isMicrosoft ? null : ref.root_key, isMicrosoft ? null : ref.relative_path,
        isMicrosoft ? null : ref.open_path, isMicrosoft ? null : ref.file_id ?? null,
        ref.mime_type ?? null, ref.size_bytes ?? null, ref.e_tag ?? null, ref.c_tag ?? null,
        ref.last_modified_at ?? null, ref.availability ?? 'unverified'],
    );
    const refId = refRows[0]?.id;
    if (refId === undefined) throw new Error('external file ref upsert returned no id');
    const occurrence = ref.occurrence;
    const originKey = occurrence
      ? `${occurrence.platform}:${occurrence.conversation_id}:${occurrence.message_id}:${occurrence.relation}`
      : `page:${pageId}`;
    await tx.executeRaw(
      `INSERT INTO page_external_file_refs
        (page_id, file_ref_id, relation, origin_key, platform, conversation_id, message_id, source_uri, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
       ON CONFLICT (page_id, file_ref_id, relation, origin_key)
       DO UPDATE SET last_seen_at = now(), source_uri = EXCLUDED.source_uri`,
      [pageId, refId, occurrence?.relation ?? 'mentioned', originKey, occurrence?.platform ?? null,
        occurrence?.conversation_id ?? null, occurrence?.message_id ?? null, occurrence?.source_uri ?? null],
    );
  }
}

export async function listExternalFileRefsForPages(
  engine: BrainEngine,
  pageIds: number[],
): Promise<Map<number, ExternalFileReferenceSummary[]>> {
  const output = new Map<number, ExternalFileReferenceSummary[]>();
  if (pageIds.length === 0) return output;
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT pfr.page_id, efr.id, efr.provider, efr.service, efr.name, efr.display_path, efr.web_url,
            efr.root_key, efr.relative_path, NULL::text AS open_path, efr.file_id,
            efr.mime_type, efr.e_tag, efr.availability,
            mp.slug AS materialized_page_slug, efr.materialized_etag, efr.materialized_stale
       FROM page_external_file_refs pfr
       JOIN external_file_refs efr ON efr.id = pfr.file_ref_id
       LEFT JOIN pages mp ON mp.id = efr.materialized_page_id
      WHERE pfr.page_id = ANY($1::int[])
      ORDER BY efr.name ASC`,
    [pageIds],
  );
  for (const row of rows) {
    const pageId = Number(row.page_id);
    const list = output.get(pageId) ?? [];
    list.push({
      id: Number(row.id),
      provider: row.provider as ExternalFileProvider,
      service: row.service as ExternalFileService,
      name: row.name as string,
      display_path: row.display_path as string | null,
      web_url: row.web_url as string | null,
      root_key: row.root_key as string | null,
      relative_path: row.relative_path as string | null,
      // Workstation paths are resolved by the client file plane. Never
      // hydrate a legacy server observation into ordinary search/query output.
      open_path: null,
      file_id: row.file_id as string | null,
      mime_type: row.mime_type as string | null,
      e_tag: row.e_tag as string | null,
      availability: (row.availability as ExternalFileAvailability) ?? 'unverified',
      materialized_page_slug: row.materialized_page_slug as string | null,
      materialized_etag: row.materialized_etag as string | null,
      materialized_stale: row.materialized_stale === true,
    });
    output.set(pageId, list);
  }
  return output;
}
