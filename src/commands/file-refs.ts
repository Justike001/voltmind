/**
 * `voltmind file-refs backfill` imports legacy cloud links and configured
 * mapped-drive paths into the external reference index. It is deliberately
 * reference-only: no connector call and no binary download happens here.
 */

import { createHash } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { isThinClient, loadConfig } from '../core/config.ts';
import { importFromContent } from '../core/import-file.ts';
import { serializePageToMarkdown } from '../core/markdown.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';
import { decorateFileRefWithClientPath, normalizeLocalFilePath } from '../core/client-file-roots.ts';
import {
  normalizePersistedExternalFileRefs,
  type ExternalFileReferenceV1,
} from '../core/external-file-refs.ts';

export interface BackfillArgs {
  dryRun: boolean;
  json: boolean;
  sourceId?: string;
  rootKey?: string;
  localRoot?: string;
  uncRoot?: string;
  /** UNC share name only; avoids transmitting username-bearing hosts. */
  uncShare?: string;
}

export interface BackfillReport {
  scanned_pages: number;
  pages_with_refs: number;
  refs_found: number;
  pages_updated: number;
  unresolved_path_refs: number;
  /** Source-scoped, credential-free preview details. URLs and provider IDs are omitted. */
  candidates: BackfillCandidate[];
  candidate_details_truncated: boolean;
}

export interface BackfillCandidate {
  page_slug: string;
  provider: ExternalFileReferenceV1['provider'];
  service: ExternalFileReferenceV1['service'];
  name: string;
  availability: ExternalFileReferenceV1['availability'];
  display_path?: string;
  root_key?: string;
  relative_path?: string;
}

const MAX_BACKFILL_CANDIDATE_DETAILS = 100;

function parseArgs(args: string[]): BackfillArgs {
  const sourceIndex = args.indexOf('--source');
  const rootKeyIndex = args.indexOf('--root-key');
  const localRootIndex = args.indexOf('--local-root');
  const uncRootIndex = args.indexOf('--unc-root');
  const uncShareIndex = args.indexOf('--unc-share');
  return {
    dryRun: args.includes('--dry-run'),
    json: args.includes('--json'),
    sourceId: sourceIndex >= 0 ? args[sourceIndex + 1] : undefined,
    rootKey: rootKeyIndex >= 0 ? args[rootKeyIndex + 1] : undefined,
    localRoot: localRootIndex >= 0 ? args[localRootIndex + 1] : undefined,
    uncRoot: uncRootIndex >= 0 ? args[uncRootIndex + 1] : undefined,
    uncShare: uncShareIndex >= 0 ? args[uncShareIndex + 1] : undefined,
  };
}

function safeUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (/(?:^|[?&])(access_token|token|sig|signature|x-amz-|se=|sp=|sv=|oauth_token)=/i.test(url.search)) return null;
    return url;
  } catch {
    return null;
  }
}

function serviceForUrl(url: URL): 'sharepoint' | 'onedrive' {
  return /sharepoint\./i.test(url.hostname) ? 'sharepoint' : 'onedrive';
}

function pathOnlyRef(rawUrl: string, label?: string): ExternalFileReferenceV1 | null {
  const url = safeUrl(rawUrl);
  if (!url) return null;
  const hash = createHash('sha256').update(url.toString()).digest('hex').slice(0, 32);
  const pathname = decodeURIComponent(url.pathname || '/');
  const fallbackName = pathname.split('/').filter(Boolean).pop() || url.hostname;
  return {
    schema_version: 1,
    provider: 'microsoft',
    service: serviceForUrl(url),
    // V1 requires non-null identity columns for its uniqueness key. These are
    // explicit unverified sentinels, never presented as Microsoft IDs; a later
    // connector event merges the row onto the real tenant/drive/item identity.
    tenant_id: 'unverified',
    drive_id: 'unverified',
    item_id: `path:${hash}`,
    name: label?.trim() || fallbackName,
    display_path: pathname,
    web_url: url.toString(),
    availability: 'unverified',
  };
}

function frontmatterRefs(value: unknown): ExternalFileReferenceV1[] {
  try {
    return normalizePersistedExternalFileRefs(value);
  } catch {
    return [];
  }
}

function stripTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/g, '');
}

function mappedDriveRef(rawPath: string, options: BackfillArgs): ExternalFileReferenceV1 | null {
  if (!options.rootKey || (!options.localRoot && !options.uncRoot && !options.uncShare)) return null;
  const candidate = rawPath.trim().replace(/[.,;:，。；：]+$/g, '');
  const roots = [options.localRoot, options.uncRoot].filter((root): root is string => Boolean(root));
  const matchedRoot = roots.find((root) => {
    const normalizedRoot = stripTrailingSeparators(root).toLowerCase();
    const normalizedCandidate = candidate.toLowerCase();
    return normalizedCandidate === normalizedRoot
      || normalizedCandidate.startsWith(`${normalizedRoot}\\`)
      || normalizedCandidate.startsWith(`${normalizedRoot}/`);
  });
  const uncMatch = !matchedRoot && options.uncShare
    ? candidate.match(/^\\\\[^\\]+\\([^\\]+)\\(.+)$/)
    : null;
  if (!matchedRoot && (!uncMatch || uncMatch[1].toLowerCase() !== options.uncShare?.toLowerCase())) return null;
  const relativePath = (matchedRoot
    ? candidate.slice(stripTrailingSeparators(matchedRoot).length).replace(/^[\\/]+/, '')
    : uncMatch![2])
    .replace(/\\/g, '/');
  if (!relativePath) return null;
  const name = relativePath.split('/').filter(Boolean).pop() ?? relativePath;
  return {
    schema_version: 1,
    provider: 'filesystem',
    service: 'raidrive',
    root_key: options.rootKey.toLowerCase(),
    relative_path: relativePath,
    name,
    display_path: relativePath,
    availability: 'unverified',
  };
}

function refsFromPage(frontmatter: unknown, text: string, options: BackfillArgs): { refs: ExternalFileReferenceV1[]; unresolved: number } {
  const refs = frontmatterRefs(frontmatter);
  const seen = new Set(refs.filter((ref) => ref.provider === 'microsoft').map((ref) => ref.web_url));
  const seenMapped = new Set(refs.filter((ref) => ref.provider === 'filesystem')
    .map((ref) => `${ref.root_key}:${ref.relative_path.toLowerCase()}`));
  let unresolved = 0;
  const linkPattern = /\[([^\]]{1,1024})\]\((https:\/\/[^)\s]+)\)/gi;
  const addUrl = (rawUrl: string, label?: string) => {
    const url = safeUrl(rawUrl);
    if (!url || (!/sharepoint\./i.test(url.hostname) && !/onedrive\./i.test(url.hostname) && !/1drv\.ms$/i.test(url.hostname))) return;
    if (seen.has(url.toString())) return;
    const ref = pathOnlyRef(url.toString(), label);
    if (!ref) return;
    refs.push(ref);
    if (ref.provider === 'microsoft') seen.add(ref.web_url);
    unresolved++;
  };
  for (const match of text.matchAll(linkPattern)) {
    addUrl(match[2], match[1]);
  }
  const rawUrlPattern = /https:\/\/[^\s)<>\]]+/gi;
  for (const match of text.matchAll(rawUrlPattern)) {
    addUrl(match[0]);
  }
  const addMappedPath = (rawPath: string) => {
    const ref = mappedDriveRef(rawPath, options);
    if (!ref || ref.provider !== 'filesystem') return;
    const key = `${ref.root_key}:${ref.relative_path.toLowerCase()}`;
    if (seenMapped.has(key)) return;
    refs.push(ref);
    seenMapped.add(key);
    unresolved++;
  };
  const inlinePathRanges: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(/`((?:[a-z]:[\\/]|\\\\)[^`\r\n]+)`/gi)) {
    addMappedPath(match[1]);
    if (match.index !== undefined) {
      inlinePathRanges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  // Markdown backticks and sentence punctuation terminate a raw path. Without
  // these delimiters, a path such as `Z:\\folder` followed by prose was
  // incorrectly indexed a second time with the closing backtick and prose.
  for (const match of text.matchAll(/(?:[a-z]:\\|\\\\[^\\\s]+\\[^\\\s]+\\)[^\s`)<>\]，。；：、]+/gi)) {
    if (match.index !== undefined && inlinePathRanges.some(range => match.index! >= range.start && match.index! < range.end)) {
      continue;
    }
    addMappedPath(match[0]);
  }
  return { refs, unresolved };
}

function backfillCandidate(pageSlug: string, ref: ExternalFileReferenceV1): BackfillCandidate {
  return ref.provider === 'filesystem'
    ? {
        page_slug: pageSlug,
        provider: ref.provider,
        service: ref.service,
        name: ref.name,
        availability: ref.availability,
        display_path: ref.display_path,
        root_key: ref.root_key,
        relative_path: ref.relative_path,
      }
    : {
        page_slug: pageSlug,
        provider: ref.provider,
        service: ref.service,
        name: ref.name,
        availability: ref.availability,
        display_path: ref.display_path,
      };
}

export async function backfillFileRefs(engine: BrainEngine, options: BackfillArgs): Promise<BackfillReport> {
  const params: unknown[] = [];
  const where = ['deleted_at IS NULL'];
  if (options.sourceId) {
    params.push(options.sourceId);
    where.push(`source_id = $${params.length}`);
  }
  const pages = await engine.executeRaw<Record<string, unknown>>(
    `SELECT id, source_id, slug, type, title, compiled_truth, timeline, frontmatter
       FROM pages WHERE ${where.join(' AND ')} ORDER BY id ASC`,
    params,
  );
  const report: BackfillReport = {
    scanned_pages: pages.length,
    pages_with_refs: 0,
    refs_found: 0,
    pages_updated: 0,
    unresolved_path_refs: 0,
    candidates: [],
    candidate_details_truncated: false,
  };

  for (const row of pages) {
    let frontmatter: unknown = row.frontmatter;
    if (typeof row.frontmatter === 'string') {
      try {
        frontmatter = JSON.parse(row.frontmatter);
      } catch {
        frontmatter = {};
      }
    }
    const text = `${String(row.compiled_truth ?? '')}\n${String(row.timeline ?? '')}`;
    const found = refsFromPage(frontmatter, text, options);
    if (found.refs.length === 0) continue;
    report.pages_with_refs++;
    report.refs_found += found.refs.length;
    report.unresolved_path_refs += found.unresolved;
    for (const ref of found.refs) {
      if (report.candidates.length >= MAX_BACKFILL_CANDIDATE_DETAILS) {
        report.candidate_details_truncated = true;
        break;
      }
      report.candidates.push(backfillCandidate(String(row.slug), ref));
    }
    if (options.dryRun) continue;

    const page = {
      id: Number(row.id),
      slug: String(row.slug),
      type: String(row.type),
      title: String(row.title),
      compiled_truth: String(row.compiled_truth ?? ''),
      timeline: String(row.timeline ?? ''),
      frontmatter: (frontmatter && typeof frontmatter === 'object' ? frontmatter : {}) as Record<string, unknown>,
    } as Parameters<typeof serializePageToMarkdown>[0];
    const content = serializePageToMarkdown(page, []);
    await importFromContent(engine, page.slug, content, {
      sourceId: String(row.source_id),
      source_kind: 'file-ref-backfill',
      source_uri: `voltmind:file-refs/backfill/${page.slug}`,
      ingested_via: 'file-refs-backfill',
      externalFileRefs: found.refs,
      noEmbed: true,
    });
    report.pages_updated++;
  }
  return report;
}

function printReport(report: BackfillReport, json: boolean): void {
  if (json) console.log(JSON.stringify(report));
  else console.log(`Scanned ${report.scanned_pages} pages; found ${report.refs_found} file refs in ${report.pages_with_refs} pages; updated ${report.pages_updated}. Unresolved path refs: ${report.unresolved_path_refs}.`);
}

function uncShareName(uncRoot: string | undefined): string | undefined {
  if (!uncRoot) return undefined;
  return uncRoot.match(/^\\\\[^\\]+\\([^\\/]+)/)?.[1];
}

export async function runFileRefs(engine: BrainEngine | null, args: string[]): Promise<void> {
  const options = parseArgs(args);
  if (args.includes('--help') || args.length === 0 || !['backfill', 'search', 'scrub-open-paths'].includes(args[0])) {
    console.log(`Usage:
  voltmind file-refs search <name-or-path> [--json]
  voltmind file-refs backfill [--dry-run] [--source <id>]
    [--root-key <key> --local-root <Z:\\> [--unc-root <UNC>]] [--json]
  voltmind file-refs scrub-open-paths [--dry-run] [--yes] [--json]

On a thin client, search resolves local paths before calling the host and
backfill sends only the drive root plus UNC share name (never the UNC host).`);
    return;
  }

  const config = loadConfig();
  if (args[0] === 'scrub-open-paths') {
    const apply = args.includes('--yes') && !args.includes('--dry-run');
    let report: Record<string, unknown>;
    if (isThinClient(config)) {
      report = unpackToolResult<Record<string, unknown>>(
        await callRemoteTool(config!, 'scrub_file_ref_open_paths', { apply }),
      );
    } else {
      if (!engine) throw new Error('local open-path scrub requires an engine');
      const { operationsByName } = await import('../core/operations.ts');
      report = await operationsByName.scrub_file_ref_open_paths.handler(
        { engine, config: config ?? {}, remote: false, sourceId: options.sourceId ?? 'default' } as any,
        { apply },
      ) as Record<string, unknown>;
    }
    console.log(JSON.stringify(report, null, options.json ? 0 : 2));
    return;
  }

  if (args[0] === 'search') {
    const query = args.slice(1).filter(arg => arg !== '--json').join(' ').trim();
    if (!query) throw new Error('file-refs search requires a name or path');
    let searchParams: Record<string, unknown> = { query };
    try {
      const logical = normalizeLocalFilePath(config, query);
      searchParams = { ...logical };
    } catch {
      // A filename or logical fragment remains a normal server-side query.
    }
    let rows: Array<Record<string, unknown>>;
    if (isThinClient(config)) {
      rows = unpackToolResult<Array<Record<string, unknown>>>(
        await callRemoteTool(config!, 'search_file_refs', searchParams),
      );
    } else {
      if (!engine) throw new Error('local file-ref search requires an engine');
      const { operationsByName } = await import('../core/operations.ts');
      rows = await operationsByName.search_file_refs.handler(
        { engine, config: config ?? {}, remote: false } as any,
        searchParams,
      ) as Array<Record<string, unknown>>;
    }
    const decorated = rows.map(row => decorateFileRefWithClientPath(config, row));
    console.log(JSON.stringify(decorated, null, options.json ? 0 : 2));
    return;
  }

  if (isThinClient(config)) {
    const rootKey = options.rootKey
      ?? Object.keys(config?.client_file_roots ?? {}).find(key => config?.client_file_roots?.[key]?.local_root);
    const mapping = rootKey ? config?.client_file_roots?.[rootKey] : undefined;
    const report = unpackToolResult<BackfillReport>(await callRemoteTool(config!, 'backfill_file_refs', {
      dry_run: options.dryRun,
      ...(rootKey ? { root_key: rootKey } : {}),
      ...((options.localRoot ?? mapping?.local_root)
        ? { local_root: options.localRoot ?? mapping?.local_root }
        : {}),
      ...((options.uncShare ?? uncShareName(options.uncRoot ?? mapping?.unc_root))
        ? { unc_share: options.uncShare ?? uncShareName(options.uncRoot ?? mapping?.unc_root) }
        : {}),
    }));
    printReport(report, options.json);
    return;
  }
  if (!engine) throw new Error('local file-ref backfill requires an engine');
  printReport(await backfillFileRefs(engine, options), options.json);
}
