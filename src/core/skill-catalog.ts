import { readFileSync, realpathSync, statSync } from 'fs';
import { basename, isAbsolute, relative, resolve } from 'path';
import type { BrainEngine } from './engine.ts';
import type { VoltMindConfig } from './config.ts';
import { autoDetectSkillsDir, autoDetectSkillsDirReadOnly } from './repo-root.ts';
import { loadOrDeriveManifest, type ManifestEntry } from './skill-manifest.ts';
import { parseSkillFrontmatter } from './skill-frontmatter.ts';
import { hasScope } from './scope.ts';

const DEFAULT_MAX_SKILL_MD_BYTES = 256 * 1024;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class SkillCatalogError extends Error {
  constructor(public code: 'permission_denied' | 'invalid_params' | 'storage_error' | 'skill_not_found', message: string) {
    super(message);
    this.name = 'SkillCatalogError';
  }
}

export interface SkillCatalogContext {
  engine: BrainEngine;
  config: VoltMindConfig;
  remote: boolean;
  grantedScopes?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CatalogToolDescriptor {
  name: string;
  scope?: string;
  localOnly?: boolean;
}

export interface PublishedSkillSummary {
  name: string;
  description?: string;
}

export interface PublishedSkill {
  name: string;
  description?: string;
  content: string;
  frontmatter: {
    name?: string;
    triggers?: string[];
    tools?: string[];
    mutating?: boolean;
    writes_pages?: boolean;
  };
  tools: {
    declared: string[];
    usable: string[];
    unavailable: string[];
  };
}

function boolFromConfig(value: string | null | undefined): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

async function readPublishEnabled(ctx: SkillCatalogContext): Promise<boolean> {
  const dbValue = await ctx.engine.getConfig('mcp.publish_skills');
  return boolFromConfig(dbValue) ?? ctx.config.mcp?.publish_skills === true;
}

async function readConfiguredSkillsDir(ctx: SkillCatalogContext): Promise<string | undefined> {
  const dbValue = await ctx.engine.getConfig('mcp.skills_dir');
  const configured = dbValue?.trim() || ctx.config.mcp?.skills_dir?.trim();
  if (!configured) return undefined;
  return isAbsolute(configured) ? configured : resolve(ctx.cwd ?? process.cwd(), configured);
}

async function resolveSkillsDir(ctx: SkillCatalogContext): Promise<string> {
  if (ctx.remote !== false && !(await readPublishEnabled(ctx))) {
    throw new SkillCatalogError(
      'permission_denied',
      'Host skill publishing is disabled. Set mcp.publish_skills=true on the Host to opt in.',
    );
  }
  const configured = await readConfiguredSkillsDir(ctx);
  if (configured) return configured;

  const cwd = ctx.cwd ?? process.cwd();
  const env = ctx.env ?? process.env;
  // Remote callers never get the install-path fallback. Publishing bundled
  // installation files by accident is not equivalent to publishing the
  // operator-selected Host workspace.
  const detected = ctx.remote !== false
    ? autoDetectSkillsDir(cwd, env)
    : autoDetectSkillsDirReadOnly(cwd, env);
  if (!detected.dir) {
    throw new SkillCatalogError(
      'storage_error',
      'No Host skills directory was found. Set mcp.skills_dir or VOLTMIND_SKILLS_DIR explicitly.',
    );
  }
  return detected.dir;
}

function maxSkillBytes(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(env.VOLTMIND_MAX_SKILL_MD_BYTES ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SKILL_MD_BYTES;
}

function assertSkillName(name: string): void {
  if (!SKILL_NAME_RE.test(name)) {
    throw new SkillCatalogError('invalid_params', 'skill name must be lowercase kebab-case (1-64 characters)');
  }
}

function validateManifest(entries: ManifestEntry[]): void {
  const names = new Set<string>();
  for (const entry of entries) {
    assertSkillName(entry.name);
    if (names.has(entry.name)) {
      throw new SkillCatalogError('storage_error', `Duplicate skill name in Host manifest: ${entry.name}`);
    }
    names.add(entry.name);
  }
}

function confinedSkillPath(skillsDir: string, entry: ManifestEntry): string {
  let root: string;
  let target: string;
  try {
    root = realpathSync(skillsDir);
    target = realpathSync(resolve(root, entry.path));
  } catch {
    throw new SkillCatalogError('storage_error', `Skill file is missing or inaccessible: ${entry.name}`);
  }
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || basename(target) !== 'SKILL.md') {
    throw new SkillCatalogError('storage_error', `Manifest path escapes the Host skills directory: ${entry.name}`);
  }
  let stat;
  try {
    stat = statSync(target);
  } catch {
    throw new SkillCatalogError('storage_error', `Skill file is inaccessible: ${entry.name}`);
  }
  if (!stat.isFile()) throw new SkillCatalogError('storage_error', `Skill path is not a regular file: ${entry.name}`);
  return target;
}

function entryDescription(entry: ManifestEntry): string | undefined {
  const value = (entry as ManifestEntry & { description?: unknown }).description;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function frontmatterDescription(content: string): string | undefined {
  const normalized = content.replace(/\r\n/g, '\n');
  const raw = normalized.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!raw) return undefined;
  const scalar = raw.match(/^description:\s*["']?([^\n"']+?)["']?\s*$/m)?.[1]?.trim();
  if (scalar) return scalar;
  const block = raw.match(/^description:\s*[|>]\s*\n((?:[ \t]+[^\n]*\n?)+)/m)?.[1];
  if (!block) return undefined;
  const text = block.split('\n').map(line => line.replace(/^[ \t]+/, '').trim()).filter(Boolean).join(' ');
  return text || undefined;
}

function skillBody(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  return normalized.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

function readSkill(skillsDir: string, entry: ManifestEntry, env: NodeJS.ProcessEnv): { content: string; path: string } {
  const path = confinedSkillPath(skillsDir, entry);
  const limit = maxSkillBytes(env);
  if (statSync(path).size > limit) {
    throw new SkillCatalogError('storage_error', `Skill exceeds the ${limit}-byte publication limit: ${entry.name}`);
  }
  const content = readFileSync(path, 'utf8');
  if (Buffer.byteLength(content, 'utf8') > limit) {
    throw new SkillCatalogError('storage_error', `Skill exceeds the ${limit}-byte publication limit: ${entry.name}`);
  }
  return { content, path };
}

export async function listPublishedSkills(ctx: SkillCatalogContext): Promise<{
  skills: PublishedSkillSummary[];
  derived_manifest: boolean;
}> {
  const skillsDir = await resolveSkillsDir(ctx);
  const manifest = loadOrDeriveManifest(skillsDir);
  validateManifest(manifest.skills);
  const skills = manifest.skills.map(entry => {
    // Validate every manifest entry before revealing the catalog. A poisoned
    // entry fails the request rather than being quietly omitted.
    const { content } = readSkill(skillsDir, entry, ctx.env ?? process.env);
    return { name: entry.name, description: entryDescription(entry) ?? frontmatterDescription(content) };
  });
  return { skills, derived_manifest: manifest.derived };
}

export async function getPublishedSkill(
  ctx: SkillCatalogContext,
  name: string,
  operationCatalog: readonly CatalogToolDescriptor[],
): Promise<PublishedSkill> {
  assertSkillName(name);
  const skillsDir = await resolveSkillsDir(ctx);
  const manifest = loadOrDeriveManifest(skillsDir);
  validateManifest(manifest.skills);
  for (const candidate of manifest.skills) confinedSkillPath(skillsDir, candidate);
  const entry = manifest.skills.find(item => item.name === name);
  if (!entry) throw new SkillCatalogError('skill_not_found', `Published skill not found: ${name}`);
  const { content } = readSkill(skillsDir, entry, ctx.env ?? process.env);
  const parsed = parseSkillFrontmatter(content);
  const declared = parsed?.tools ?? [];
  const granted = ctx.remote === false ? null : (ctx.grantedScopes ?? ['read', 'write']);
  const usable = declared.filter(toolName => {
    const op = operationCatalog.find(candidate => candidate.name === toolName);
    if (!op || op.localOnly) return false;
    return granted === null || hasScope(granted, op.scope ?? 'read');
  });
  return {
    name: entry.name,
    description: entryDescription(entry) ?? frontmatterDescription(content),
    content: skillBody(content),
    frontmatter: {
      name: parsed?.name,
      triggers: parsed?.triggers,
      tools: parsed?.tools,
      mutating: parsed?.mutating,
      writes_pages: parsed?.writes_pages,
    },
    tools: {
      declared,
      usable,
      unavailable: declared.filter(tool => !usable.includes(tool)),
    },
  };
}
