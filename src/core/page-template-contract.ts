import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { parseTimelineEntries } from './link-extraction.ts';
import { inferTypeFromPack } from './markdown.ts';
// Keep the canonical draft available inside compiled thin-client binaries.
// The source file remains the only authority; this text import is its build-time
// embedding, not a second hand-maintained template registry.
// @ts-ignore — Bun text imports are not represented in TypeScript's lib types.
import EMBEDDED_CANONICAL_PAGE_TEMPLATE_DRAFT from '../../docs/drafts/voltmind-company-core-page-templates.draft.md' with { type: 'text' };

export const CANONICAL_PAGE_TEMPLATE_DRAFT =
  'docs/drafts/voltmind-company-core-page-templates.draft.md';

export type TemplateContractMode = 'off' | 'warn' | 'strict';

export interface PageTemplateField {
  path: string;
  draftValue: string;
  enumValues?: string[];
  shape?: 'array' | 'object';
}

export interface PageTemplateContract {
  type: string;
  section: string;
  fields: PageTemplateField[];
  headings: string[];
  requiresH1: boolean;
  requiresTimelineMarker: boolean;
}

export interface PageTemplateContractSet {
  draftPath: string;
  templates: ReadonlyMap<string, PageTemplateContract>;
}

export interface TemplateContractFinding {
  code:
  | 'DRAFT_UNAVAILABLE'
  | 'MISSING_FIELD'
  | 'INVALID_FIELD_SHAPE'
  | 'INVALID_FIELD_VALUE'
  | 'TYPE_MISMATCH'
  | 'PATH_TYPE_MISMATCH'
  | 'MISSING_H1'
  | 'MISSING_HEADING'
  | 'MISSING_TIMELINE_MARKER'
  | 'INVALID_TIMELINE_FORMAT'
  | 'BODY_LANGUAGE_MISMATCH';
  message: string;
  field?: string;
  heading?: string;
}

export interface TemplateContractValidation {
  draftPath: string;
  type: string;
  section: string;
  findings: TemplateContractFinding[];
}

let cachedContract: { path: string; mtimeMs: number; set: PageTemplateContractSet } | null = null;

/**
 * Resolve the one canonical page-format document. The environment override is
 * intentional for packaged deployments; source checkouts resolve it without
 * configuration from either the current repository or the module location.
 */
export function resolveCanonicalPageTemplateDraft(): string | null {
  const configured = process.env.VOLTMIND_PAGE_TEMPLATE_DRAFT?.trim();
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    configured,
    join(process.cwd(), CANONICAL_PAGE_TEMPLATE_DRAFT),
    join(here, '..', '..', CANONICAL_PAGE_TEMPLATE_DRAFT),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function loadCanonicalPageTemplateContract(): PageTemplateContractSet {
  const resolvedDraftPath = resolveCanonicalPageTemplateDraft();
  const draftPath = resolvedDraftPath ?? `embedded:${CANONICAL_PAGE_TEMPLATE_DRAFT}`;
  const content = resolvedDraftPath
    ? readFileSync(resolvedDraftPath, 'utf8')
    : EMBEDDED_CANONICAL_PAGE_TEMPLATE_DRAFT;
  const mtimeMs = resolvedDraftPath ? statSync(resolvedDraftPath).mtimeMs : 0;

  // The draft is stable during a process lifetime in normal operation. The
  // content hash is cheap for this small design document and also makes tests
  // deterministic when a temporary draft is selected via the env override.
  const cacheKey = `${draftPath}:${content.length}:${content.slice(0, 64)}`;
  if (cachedContract?.path === cacheKey && cachedContract.mtimeMs === mtimeMs) {
    return cachedContract.set;
  }

  const set: PageTemplateContractSet = {
    draftPath,
    templates: parseTemplateDraft(content),
  };
  if (set.templates.size === 0) {
    throw new Error(`Canonical page template draft contains no page templates: ${draftPath}`);
  }
  cachedContract = { path: cacheKey, mtimeMs, set };
  return set;
}

/** Reset only the in-process cache; used by contract parser tests. */
export function resetCanonicalPageTemplateContractCache(): void {
  cachedContract = null;
}

export function validateCanonicalPageTemplate(
  slug: string,
  content: string,
  activePack?: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> },
): TemplateContractValidation | null {
  const set = loadCanonicalPageTemplateContract();
  const parsed = matter(content);
  const frontmatter = parsed.data as Record<string, unknown>;
  const declaredType = typeof frontmatter.type === 'string' ? frontmatter.type.trim() : '';
  const pathType = inferTypeFromPack(`${slug}.md`, activePack);
  const type = declaredType || pathType;
  const contract = set.templates.get(type);
  if (!contract) return null;

  const findings: TemplateContractFinding[] = [];
  for (const field of contract.fields) {
    const value = readField(frontmatter, field.path);
    if (!value.present) {
      findings.push({
        code: 'MISSING_FIELD',
        field: field.path,
        message: `missing required frontmatter field '${field.path}'`,
      });
      continue;
    }
    if (field.shape === 'array' && !Array.isArray(value.value)) {
      findings.push({
        code: 'INVALID_FIELD_SHAPE',
        field: field.path,
        message: `frontmatter field '${field.path}' must be an array`,
      });
    } else if (field.shape === 'object' || field.path === 'automation' || field.path === 'agent_contract' || field.path === 'writeback') {
      if (!isRecord(value.value)) {
        findings.push({
          code: 'INVALID_FIELD_SHAPE',
          field: field.path,
          message: `frontmatter field '${field.path}' must be an object`,
        });
      }
    }
    if (field.enumValues && (typeof value.value !== 'string' || !field.enumValues.includes(value.value))) {
      findings.push({
        code: 'INVALID_FIELD_VALUE',
        field: field.path,
        message: `frontmatter field '${field.path}' must be one of: ${field.enumValues.join(', ')}`,
      });
    }
  }

  if (declaredType !== contract.type) {
    findings.push({
      code: 'TYPE_MISMATCH',
      field: 'type',
      message: `frontmatter type must be '${contract.type}'`,
    });
  }
  if (pathType !== 'unclassified' && pathType !== contract.type) {
    findings.push({
      code: 'PATH_TYPE_MISMATCH',
      message: `slug '${slug}' belongs to type '${pathType}', not '${contract.type}'`,
    });
  }

  const headings = extractHeadings(parsed.content);
  if (contract.requiresH1 && !/^#\s+\S/m.test(parsed.content)) {
    findings.push({ code: 'MISSING_H1', message: 'page body must contain an H1 title heading' });
  }
  for (const heading of contract.headings) {
    if (!headings.has(heading)) {
      findings.push({
        code: 'MISSING_HEADING',
        heading,
        message: `page body must contain heading '## ${heading}'`,
      });
    }
  }
  if (contract.requiresTimelineMarker && !parsed.content.includes('<!-- timeline -->')) {
    findings.push({
      code: 'MISSING_TIMELINE_MARKER',
      message: "page body must contain the canonical '<!-- timeline -->' marker",
    });
  }

  const timelineBody = extractH2Section(parsed.content, 'Timeline');
  if (timelineBody !== null) {
    for (const line of timelineBody.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('-')) continue;
      if (parseTimelineEntries(trimmed).length === 0) {
        findings.push({
          code: 'INVALID_TIMELINE_FORMAT',
          heading: 'Timeline',
          message: "timeline entries must use '- **YYYY-MM-DD** | 中文摘要 [Source: ...]'",
        });
        break;
      }
    }
  }

  const languageExemptHeadings = new Set(['Transcript', 'Raw / Pointer', 'Evidence']);
  for (const section of extractBodySections(parsed.content)) {
    // Raw evidence keeps the source language verbatim. The Chinese-language
    // contract applies to synthesized prose, not transcripts or quoted proof.
    if (section.heading && languageExemptHeadings.has(section.heading)) continue;
    const prose = stripNonProseMarkup(section.content);
    const latinLetters = (prose.match(/[A-Za-z]/g) ?? []).length;
    const hasChinese = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u.test(prose);
    if (latinLetters >= 12 && !hasChinese) {
      findings.push({
        code: 'BODY_LANGUAGE_MISMATCH',
        ...(section.heading ? { heading: section.heading } : {}),
        message: section.heading
          ? `body content under '## ${section.heading}' must be written in Chinese`
          : 'body introduction must be written in Chinese',
      });
    }
  }

  return {
    draftPath: set.draftPath,
    type: contract.type,
    section: contract.section,
    findings,
  };
}

function parseTemplateDraft(markdown: string): Map<string, PageTemplateContract> {
  const lines = markdown.split(/\r?\n/);
  const coreEnums = parseCoreFieldEnums(lines);
  const sections: Array<{ title: string; lines: string[] }> = [];
  let current: { title: string; lines: string[] } | null = null;
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    if (!inFence && /^##\s+[^#]/.test(line)) {
      if (current) sections.push(current);
      current = { title: line.replace(/^##\s+/, '').trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);

  const templates = new Map<string, PageTemplateContract>();
  for (const section of sections) {
    for (const block of extractFencedBlocks(section.lines)) {
      const frontmatter = extractFrontmatterBlock(block);
      if (!frontmatter) continue;
      const fields = parseTemplateFields(frontmatter);
      const typeField = fields.find((field) => field.path === 'type');
      const type = typeField?.draftValue.trim();
      if (!type || !/^[a-z][a-z0-9_]*$/.test(type)) continue;
      const body = extractTemplateBody(block);
      const headings = [...extractHeadings(body)].filter((heading) => heading.length > 0);
      for (const field of fields) {
        if (!field.enumValues && coreEnums.has(field.path)) {
          field.enumValues = coreEnums.get(field.path);
        }
      }
      templates.set(type, {
        type,
        section: section.title,
        fields,
        headings,
        requiresH1: /^#\s+\S/m.test(body),
        requiresTimelineMarker: body.includes('<!-- timeline -->'),
      });
      break;
    }
  }
  return templates;
}

function parseCoreFieldEnums(lines: string[]): Map<string, string[]> {
  const enums = new Map<string, string[]>();
  const coreFields = new Set(['scope', 'visibility', 'sensitivity', 'promotion', 'publish_level', 'status']);
  for (const line of lines) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (!match || !coreFields.has(match[1]!)) continue;
    const values = [...match[2]!.matchAll(/`([^`]+)`/g)].map((value) => value[1]!).filter(Boolean);
    if (values.length > 0) enums.set(match[1]!, values);
  }
  return enums;
}

function extractFencedBlocks(lines: string[]): string[] {
  const blocks: string[] = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) {
      if (start < 0) start = i + 1;
      else {
        blocks.push(lines.slice(start, i).join('\n'));
        start = -1;
      }
    }
  }
  // A partially edited draft should still be diagnosable by the contract
  // loader. The canonical document is kept valid, but treating a trailing
  // unterminated fence as a block prevents the last template from silently
  // disappearing during a migration or conflict resolution.
  if (start >= 0) blocks.push(lines.slice(start).join('\n'));
  return blocks;
}

function extractTemplateBody(block: string): string {
  const lines = block.split(/\r?\n/);
  const open = lines.findIndex((line) => line.trim() === '---');
  if (open < 0) return block;
  const close = lines.findIndex((line, index) => index > open && line.trim() === '---');
  if (close < 0) return '';
  return lines.slice(close + 1).join('\n');
}

function extractFrontmatterBlock(block: string): string | null {
  const lines = block.split(/\r?\n/);
  const open = lines.findIndex((line) => line.trim() === '---');
  if (open < 0) return null;
  const close = lines.findIndex((line, index) => index > open && line.trim() === '---');
  if (close < 0) return null;
  return lines.slice(open + 1, close).join('\n');
}

function parseTemplateFields(frontmatter: string): PageTemplateField[] {
  const fields: PageTemplateField[] = [];
  const stack: Array<{ indent: number; path: string }> = [];
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#') || /^\s*-/.test(line)) continue;
    const match = /^(\s*)([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line);
    if (!match) continue;
    const indent = match[1].length;
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const path = [...stack.map((entry) => entry.path), match[2]].join('.');
    const draftValue = (match[3] ?? '').trim();
    const field: PageTemplateField = { path, draftValue };
    if (/^\[/.test(draftValue)) field.shape = 'array';
    else if (draftValue === '{}' || draftValue === '') field.shape = undefined;
    if (draftValue.includes('|')) {
      field.enumValues = draftValue.split('|').map((value) => value.trim()).filter(Boolean);
    }
    fields.push(field);
    if (!draftValue) stack.push({ indent, path });
  }
  return fields;
}

function extractHeadings(body: string): Set<string> {
  const headings = new Set<string>();
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      const match = /^##\s+(.+?)\s*$/.exec(line);
      if (match) headings.add(match[1]!);
    }
  }
  return headings;
}

function extractH2Section(body: string, heading: string): string | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

function extractBodySections(body: string): Array<{ heading?: string; content: string }> {
  const sections: Array<{ heading?: string; content: string }> = [];
  let heading: string | undefined;
  let lines: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      if (lines.some((entry) => entry.trim().length > 0)) sections.push({ heading, content: lines.join('\n') });
      heading = match[1]!;
      lines = [];
      continue;
    }
    if (/^#\s+/.test(line)) continue;
    lines.push(line);
  }
  if (lines.some((entry) => entry.trim().length > 0)) sections.push({ heading, content: lines.join('\n') });
  return sections;
}

function stripNonProseMarkup(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<!--[^]*?-->/g, '')
    .replace(/\[Source:[^\]]*\]/gi, '')
    .replace(/!?(?:\[[^\]]*\])?\([^)]*\)/g, '')
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/`[^`]*`/g, '')
    .trim();
}

function readField(root: Record<string, unknown>, path: string): { present: boolean; value: unknown } {
  const parts = path.split('.');
  let current: unknown = root;
  for (const part of parts) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return { present: false, value: undefined };
    }
    current = current[part];
  }
  return { present: true, value: current };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function resolveTemplateContractMode(
  engine: { getConfig(key: string): Promise<unknown> },
  options: { remote?: boolean } = {},
): Promise<TemplateContractMode> {
  const configured = await engine.getConfig('writer.template_contract').catch(() => undefined);
  if (configured === false) return 'off';
  if (configured === true) return 'strict';
  const normalized = typeof configured === 'string' ? configured.trim().toLowerCase() : '';
  if (normalized === 'off' || normalized === 'false' || normalized === '0') return 'off';
  if (normalized === 'warn') return 'warn';
  if (normalized === 'strict' || normalized === 'true' || normalized === '1') return 'strict';

  const repoPath = await engine.getConfig('sync.repo_path').catch(() => undefined);
  if (typeof repoPath === 'string' && existsSync(repoPath)) return 'strict';
  // Client-first semantic writes arrive through MCP and must fail closed even
  // when the database host does not have a local vault checkout. Raw server
  // ingestion uses importFromContent directly and is intentionally outside
  // this agent-authored page contract.
  return options.remote === true ? 'strict' : 'off';
}
