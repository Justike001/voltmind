/**
 * Read-only reconciliation of a local markdown source against active pages.
 *
 * This command deliberately does not delete or update pages.  It produces a
 * JSON + Markdown inventory so an operator can review the proposed soft-delete
 * candidates before running any cleanup workflow.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseMarkdown } from '../core/markdown.ts';
import { unsyncableReason } from '../core/sync.ts';
import type { BrainEngine } from '../core/engine.ts';

export type AuditBucket =
  | 'current_source_keep'
  | 'historical_entity'
  | 'high_confidence_noise'
  | 'manual_review';

export interface AuditPageRow {
  id: number;
  slug: string;
  source_id: string;
  source_path: string | null;
  type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  updated_at: string | null;
}

export interface AuditEntry {
  id: number;
  slug: string;
  title: string;
  type: string;
  source_path: string | null;
  bucket: AuditBucket;
  action: 'keep' | 'hold' | 'soft_delete_candidate' | 'manual_review';
  confidence: number;
  reasons: string[];
  referenced_by: string[];
  body_length: number;
}

export interface SourceFileAudit {
  relative_path: string;
  parse_ok: boolean;
  parse_errors: string[];
  referenced_slugs: string[];
}

export interface SourceAuditReport {
  schema_version: 1;
  generated_at: string;
  dry_run: true;
  mutation_performed: false;
  source: {
    id: string;
    directory: string;
    markdown_files: number;
    syncable_files: number;
    sync_skipped_files: number;
    sync_exclusion_note: string;
    parse_error_files: number;
  };
  database: {
    active_pages: number;
    pages_with_source_path: number;
    pages_without_source_path: number;
  };
  summary: Record<AuditBucket, number>;
  pages: AuditEntry[];
  source_files: SourceFileAudit[];
}

interface ParsedSourceFile {
  relativePath: string;
  raw: string;
  frontmatter: Record<string, unknown>;
  body: string;
  parsed: SourceFileAudit;
}

const ENTITY_PREFIXES = ['people/', 'person/', 'companies/', 'company/', 'projects/', 'project/'];
const ENTITY_TYPES = new Set(['person', 'company', 'project']);

// These markers are intentionally conservative and explainable.  A page is
// only promoted to high-confidence noise when it has no source path, no
// explicit reference, and the score reaches the threshold in scoreNoise().
const PHRASE_MARKERS = /\b(?:accepts?|add|adjusted|admin|agent|allowed?|anthropic|apple|asserts?|auth|bearer|best|birthday|book|brain|bulk|calendar|can|claude|command|config|configuration|creates?|current|default|deleted|development|draft|email|engineering|example|follow(?:-up)?|forward|free|full|generated|get|has|how|inbox|index|integration|invalid|local|many|mcp|migration|new|no|open|optional|outlook|people|private|project|published|read|remote|required|review|role|schema|settings?|source|supports?|team|template|test|tool|tools|use|using|valid|what|when|where|why|workflow|work|workspace|url|database|field|property|format|pattern)\b/i;
const TOOL_MARKERS = /\b(?:cursor|claude|chatgpt|notion|slack|github|supabase|openai|docker|bun|npm|npx|python|typescript|javascript|postgres|pglite|mcp|sdk|yaml|json|markdown|regex|twilio|microsoft|outlook|anthropic|apple|copilot)\b/i;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function normalizeSlug(value: string): string {
  return normalizePath(value.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0].split('#')[0]).replace(/\.md$/i, '');
}

function slugFromSourceFile(relativePath: string): string {
  return normalizeSlug(relativePath);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Convert both relative and absolute DB paths to a source-relative path. */
export function sourceRelativePath(sourceDir: string, sourcePath: string | null): string | null {
  if (!sourcePath?.trim()) return null;
  const root = resolve(sourceDir);
  const raw = sourcePath.trim();
  if (isAbsolute(raw)) {
    const absolute = resolve(raw);
    return isInside(root, absolute) ? normalizePath(relative(root, absolute)) : normalizePath(raw);
  }
  const normalized = normalizePath(raw);
  const rootName = normalizePath(basename(root));
  return normalized.toLowerCase().startsWith(`${rootName.toLowerCase()}/`)
    ? normalized.slice(rootName.length + 1)
    : normalized;
}

function listMarkdownFiles(root: string): string[] {
  const ignored = new Set(['.git', 'node_modules', '.voltmind', '.sources', 'reports']);
  const result: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) walk(join(dir, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        result.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return result.sort((a, b) => a.localeCompare(b));
}

function collectStringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStringValues(item, out);
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectStringValues(item, out);
  }
  return out;
}

function extractExplicitRefs(raw: string, frontmatter: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  const add = (value: string) => {
    const slug = normalizeSlug(value);
    if (slug && !/^https?:/i.test(slug) && !slug.startsWith('mailto:')) refs.add(slug);
  };
  for (const match of raw.matchAll(/\[\[([^\]]+)\]\]/g)) add(match[1]);
  for (const match of raw.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, '').split(/[?#]/)[0];
    if (target && !/^https?:/i.test(target) && !target.startsWith('mailto:')) add(target);
  }
  for (const value of collectStringValues(frontmatter)) {
    for (const match of value.matchAll(/\[\[([^\]]+)\]\]/g)) add(match[1]);
    if (/^(?:[\w.-]+\/)+[\w.-]+(?:\.md)?$/i.test(value.trim())) add(value);
  }
  return [...refs].sort();
}

function looksLikeEntity(page: Pick<AuditPageRow, 'slug' | 'type' | 'title'>): boolean {
  const slug = page.slug.toLowerCase();
  return ENTITY_TYPES.has(page.type.toLowerCase()) || ENTITY_PREFIXES.some(prefix => slug.startsWith(prefix));
}

function scoreNoise(page: Pick<AuditPageRow, 'slug' | 'type' | 'title' | 'compiled_truth' | 'timeline'>): { score: number; reasons: string[] } {
  const label = `${page.title} ${page.slug}`;
  const reasons: string[] = [];
  let score = 0;
  if (PHRASE_MARKERS.test(label)) {
    score += 0.5;
    reasons.push('title_or_slug_contains_phrase_marker');
  }
  if (TOOL_MARKERS.test(label)) {
    score += 0.3;
    reasons.push('title_or_slug_contains_tool_or_config_marker');
  }
  const words = page.title.trim().split(/\s+/).filter(Boolean);
  if (/[/:()[\]{}]/.test(page.title) || words.length >= 6) {
    score += 0.2;
    reasons.push('title_looks_like_template_or_instruction');
  }
  const bodyLength = page.compiled_truth.length + page.timeline.length;
  if (bodyLength <= 500) {
    score += 0.15;
    reasons.push('short_historical_body');
  }
  if (page.type.toLowerCase() === 'person' && words.length <= 1 && !/^[A-Z][a-z]+$/.test(page.title.trim())) {
    score += 0.15;
    reasons.push('person_type_but_title_is_not_name_shaped');
  }
  return { score: Math.min(1, Number(score.toFixed(2))), reasons };
}

function parseSourceFiles(sourceDir: string): { files: ParsedSourceFile[]; audits: SourceFileAudit[] } {
  const root = resolve(sourceDir);
  const files: ParsedSourceFile[] = [];
  const audits: SourceFileAudit[] = [];
  for (const absolutePath of listMarkdownFiles(root)) {
    const relativePath = normalizePath(relative(root, absolutePath));
    const raw = readFileSync(absolutePath, 'utf8');
    let parsed;
    try {
      parsed = parseMarkdown(raw, relativePath, { validate: true });
    } catch (error) {
      const audit: SourceFileAudit = {
        relative_path: relativePath,
        parse_ok: false,
        parse_errors: [String(error)],
        referenced_slugs: extractExplicitRefs(raw, {}),
      };
      audits.push(audit);
      files.push({ relativePath, raw, frontmatter: {}, body: raw, parsed: audit });
      continue;
    }
    const errors = parsed.errors ?? [];
    const audit: SourceFileAudit = {
      relative_path: relativePath,
      parse_ok: errors.length === 0,
      parse_errors: errors.map(item => `${item.code}: ${item.message}`),
      referenced_slugs: extractExplicitRefs(raw, parsed.frontmatter),
    };
    audits.push(audit);
    files.push({
      relativePath,
      raw,
      frontmatter: parsed.frontmatter,
      body: `${parsed.compiled_truth}\n${parsed.timeline}`,
      parsed: audit,
    });
  }
  return { files, audits };
}

function buildReferenceIndex(files: ParsedSourceFile[], pages: AuditPageRow[]): Map<string, string[]> {
  const bySlug = new Map(pages.map(page => [normalizeSlug(page.slug).toLowerCase(), page]));
  const references = new Map<string, Set<string>>();
  const add = (slug: string, file: string) => {
    const key = normalizeSlug(slug).toLowerCase();
    const page = bySlug.get(key);
    if (!page) return;
    const set = references.get(page.slug) ?? new Set<string>();
    set.add(file);
    references.set(page.slug, set);
  };
  for (const file of files) {
    for (const slug of file.parsed.referenced_slugs) add(slug, file.relativePath);
    // Plain-text title references are only considered for entity-shaped pages;
    // this prevents a common word such as "Project" from retaining hundreds
    // of unrelated historical concept rows.
    for (const page of pages) {
      if (!looksLikeEntity(page) || page.title.trim().length < 4) continue;
      const escaped = page.title.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchable = `${file.body}\n${JSON.stringify(file.frontmatter)}`;
      if (new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}([^\\p{L}\\p{N}_-]|$)`, 'iu').test(searchable)) {
        add(page.slug, file.relativePath);
      }
    }
  }
  return new Map([...references.entries()].map(([slug, filesForPage]) => [slug, [...filesForPage].sort()]));
}

export function classifyPage(page: AuditPageRow, opts: {
  sourceDir: string;
  currentPaths: Set<string>;
  currentSlugs?: Set<string>;
  referencedBy?: string[];
}): AuditEntry {
  const relativePath = sourceRelativePath(opts.sourceDir, page.source_path);
  const referencedBy = opts.referencedBy ?? [];
  const current = (relativePath ? opts.currentPaths.has(relativePath.toLowerCase()) : false) ||
    (opts.currentSlugs?.has(normalizeSlug(page.slug).toLowerCase()) ?? false);
  if (current) {
    return {
      id: page.id, slug: page.slug, title: page.title, type: page.type,
      source_path: page.source_path, bucket: 'current_source_keep', action: 'keep',
      confidence: 1,
      reasons: [
        ...(relativePath && opts.currentPaths.has(relativePath.toLowerCase()) ? ['source_path_matches_current_markdown_file'] : []),
        ...(opts.currentSlugs?.has(normalizeSlug(page.slug).toLowerCase()) ? ['slug_matches_current_markdown_file'] : []),
      ],
      referenced_by: referencedBy,
      body_length: page.compiled_truth.length + page.timeline.length,
    };
  }
  if (referencedBy.length > 0 && looksLikeEntity(page)) {
    return {
      id: page.id, slug: page.slug, title: page.title, type: page.type,
      source_path: page.source_path, bucket: 'historical_entity', action: 'hold',
      confidence: 0.95, reasons: ['explicitly_referenced_by_current_source'], referenced_by: referencedBy,
      body_length: page.compiled_truth.length + page.timeline.length,
    };
  }
  const noise = scoreNoise(page);
  const bodyLength = page.compiled_truth.length + page.timeline.length;
  const entryBase = {
    id: page.id, slug: page.slug, title: page.title, type: page.type,
    source_path: page.source_path, confidence: noise.score, referenced_by: referencedBy, body_length: bodyLength,
  };
  if (!page.source_path && noise.score >= 0.75) {
    return { ...entryBase, bucket: 'high_confidence_noise', action: 'soft_delete_candidate', reasons: noise.reasons };
  }
  return {
    ...entryBase,
    bucket: 'manual_review',
    action: 'manual_review',
    reasons: [
      ...(page.source_path ? ['source_path_not_found_in_current_source'] : ['missing_source_path']),
      ...(referencedBy.length > 0 ? ['referenced_but_not_entity_shaped'] : []),
      ...(looksLikeEntity(page) ? ['entity_shaped_title_or_type'] : ['not_high_confidence_noise']),
      ...noise.reasons,
    ],
  };
}

export function renderSourceAuditMarkdown(report: SourceAuditReport): string {
  const lines: string[] = [];
  const bucketLabels: Record<AuditBucket, string> = {
    current_source_keep: '当前 source 保留页',
    historical_entity: '历史实体',
    high_confidence_noise: '高置信噪声',
    manual_review: '待人工审核',
  };
  lines.push(`# Supabase source reconciliation audit\n`);
  lines.push(`- Generated: ${report.generated_at}`);
  lines.push(`- Source: \`${report.source.id}\` — \`${report.source.directory}\``);
  lines.push(`- Read-only: yes (no soft deletes or other mutations were performed)\n`);
  lines.push('## Summary\n');
  lines.push(`| Metric | Count |`);
  lines.push(`|---|---:|`);
  lines.push(`| Current source Markdown files | ${report.source.markdown_files} |`);
  lines.push(`| Canonical syncable files | ${report.source.syncable_files} |`);
  lines.push(`| Canonical sync-skipped files | ${report.source.sync_skipped_files} |`);
  lines.push(`| Sync exclusion note | ${report.source.sync_exclusion_note} |`);
  lines.push(`| Active Supabase pages | ${report.database.active_pages} |`);
  lines.push(`| Active pages with source_path | ${report.database.pages_with_source_path} |`);
  lines.push(`| Active pages without source_path | ${report.database.pages_without_source_path} |`);
  for (const bucket of ['current_source_keep', 'historical_entity', 'high_confidence_noise', 'manual_review'] as AuditBucket[]) {
    lines.push(`| ${bucket} | ${report.summary[bucket]} |`);
  }
  for (const bucket of ['current_source_keep', 'historical_entity', 'high_confidence_noise', 'manual_review'] as AuditBucket[]) {
    lines.push(`\n## ${bucketLabels[bucket]} (${bucket}, ${report.summary[bucket]})\n`);
    const pages = report.pages.filter(page => page.bucket === bucket);
    if (pages.length === 0) { lines.push('_None._'); continue; }
    for (const page of pages) {
      const title = page.title.replaceAll('|', '\\|').replaceAll('\n', ' ');
      lines.push(`- **${page.slug}** — ${title} _(type=${page.type}, confidence=${page.confidence.toFixed(2)}, action=${page.action})_`);
      if (page.source_path) lines.push(`  - source_path: \`${page.source_path}\``);
      if (page.referenced_by.length) lines.push(`  - referenced_by: ${page.referenced_by.map(path => `\`${path}\``).join(', ')}`);
      lines.push(`  - reasons: ${page.reasons.join(', ')}`);
    }
  }
  lines.push('\n## Parse diagnostics\n');
  const bad = report.source_files.filter(file => !file.parse_ok);
  if (bad.length === 0) lines.push('_All Markdown files parsed successfully._');
  else for (const file of bad) lines.push(`- \`${file.relative_path}\`: ${file.parse_errors.join('; ')}`);
  return `${lines.join('\n')}\n`;
}

export async function buildSourceAuditReport(engine: BrainEngine, opts: { sourceId: string; sourceDir: string }): Promise<SourceAuditReport> {
  const sourceDir = resolve(opts.sourceDir);
  if (!existsSync(sourceDir)) throw new Error(`Source directory does not exist: ${sourceDir}`);
  const { files, audits } = parseSourceFiles(sourceDir);
  const rows = await engine.executeRaw<AuditPageRow>(
    `SELECT id, slug, source_id, source_path, type, title, compiled_truth, timeline, frontmatter, updated_at
       FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL
      ORDER BY slug`,
    [opts.sourceId],
  );
  const pages = rows.map(row => ({ ...row, frontmatter: asRecord(row.frontmatter) }));
  const currentPaths = new Set(files.map(file => file.relativePath.toLowerCase()));
  const currentSlugs = new Set(files.map(file => slugFromSourceFile(file.relativePath).toLowerCase()));
  // Only pages that survive the source_path match are allowed to retain
  // historical rows. README/template/infrastructure files are intentionally
  // not part of this evidence set; otherwise a template mentioning
  // "Company Name" would protect a generated people/* row forever.
  const pageSlugs = new Set(pages.map(page => normalizeSlug(page.slug).toLowerCase()));
  const retainedFilePaths = new Set(
    files
      .filter(file => pageSlugs.has(slugFromSourceFile(file.relativePath).toLowerCase()))
      .map(file => file.relativePath.toLowerCase()),
  );
  const referenceIndex = buildReferenceIndex(
    files.filter(file => retainedFilePaths.has(file.relativePath.toLowerCase())),
    pages,
  );
  const entries = pages.map(page => classifyPage(page, {
    sourceDir,
    currentPaths,
    currentSlugs,
    referencedBy: referenceIndex.get(page.slug) ?? [],
  }));
  const summary = {
    current_source_keep: entries.filter(page => page.bucket === 'current_source_keep').length,
    historical_entity: entries.filter(page => page.bucket === 'historical_entity').length,
    high_confidence_noise: entries.filter(page => page.bucket === 'high_confidence_noise').length,
    manual_review: entries.filter(page => page.bucket === 'manual_review').length,
  } satisfies Record<AuditBucket, number>;
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    dry_run: true,
    mutation_performed: false,
    source: {
      id: opts.sourceId,
      directory: sourceDir,
      markdown_files: files.length,
      syncable_files: files.filter(file => unsyncableReason(file.relativePath) === null).length,
      sync_skipped_files: files.filter(file => unsyncableReason(file.relativePath) !== null).length,
      sync_exclusion_note: 'Current sync excludes README.md, index.md, schema.md, and log.md by basename.',
      parse_error_files: audits.filter(file => !file.parse_ok && unsyncableReason(file.relative_path) === null).length,
    },
    database: {
      active_pages: pages.length,
      pages_with_source_path: pages.filter(page => !!page.source_path).length,
      pages_without_source_path: pages.filter(page => !page.source_path).length,
    },
    summary,
    pages: entries,
    source_files: audits,
  };
}

function argValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? null : null;
}

export async function runSourceAudit(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: voltmind source-audit --source-dir <path> [--source-id <id>] [--out-dir <path>] [--json]');
    console.log('       voltmind source-audit ... --apply --confirm --buckets high_confidence_noise,manual_review');
    console.log('       --apply requires --confirm and soft-deletes only the selected buckets; no hard purge is performed.');
    return;
  }
  const sourceDir = argValue(args, '--source-dir');
  if (!sourceDir) throw new Error('source-audit requires --source-dir <path>');
  let sourceId = argValue(args, '--source-id');
  if (!sourceId) {
    const sources = await engine.listAllSources();
    const root = resolve(sourceDir).toLowerCase();
    const match = sources.find(source => source.local_path && resolve(source.local_path).toLowerCase() === root);
    if (match) sourceId = match.id;
    else if (sources.length === 1) sourceId = sources[0].id;
    else throw new Error('Unable to infer source id; pass --source-id explicitly');
  }
  const report = await buildSourceAuditReport(engine, { sourceId, sourceDir });
  const outDir = resolve(argValue(args, '--out-dir') ?? join(process.cwd(), 'reports', 'source-audit'));
  mkdirSync(outDir, { recursive: true });
  const stamp = report.generated_at.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const jsonPath = join(outDir, `source-audit-${stamp}.json`);
  const markdownPath = join(outDir, `source-audit-${stamp}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, renderSourceAuditMarkdown(report), 'utf8');
  if (args.includes('--apply')) {
    if (!args.includes('--confirm')) {
      throw new Error('source-audit --apply requires --confirm; reports are otherwise read-only');
    }
    const requested = (argValue(args, '--buckets') ?? '').split(',').map(value => value.trim()).filter(Boolean) as AuditBucket[];
    const allowed = new Set<AuditBucket>(['current_source_keep', 'historical_entity', 'high_confidence_noise', 'manual_review']);
    if (requested.length === 0 || requested.some(bucket => !allowed.has(bucket))) {
      throw new Error('source-audit --apply requires --buckets with one or more valid bucket names');
    }
    const targets = report.pages.filter(page => requested.includes(page.bucket));
    let deleted = 0;
    for (const target of targets) {
      const result = await engine.softDeletePage(target.slug, { sourceId });
      if (result) deleted++;
    }
    console.log(`Soft-deleted ${deleted}/${targets.length} selected pages in source ${sourceId}.`);
  }
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(`Source audit written:\n  JSON: ${jsonPath}\n  Markdown: ${markdownPath}`);
}
