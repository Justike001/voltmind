/**
 * Read-only adapters for the P1 skill platform MCP surface.
 *
 * These functions deliberately do not shell out or accept caller-controlled
 * workspace roots. MCP callers can inspect the server's configured skill
 * workspace, but all skill/file mutation remains a trusted local CLI action.
 */

import { existsSync, lstatSync, realpathSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';
import type { BrainEngine } from './engine.ts';
import { checkResolvable } from './check-resolvable.ts';
import { autoDetectSkillsDirReadOnly } from './repo-root.ts';
import {
  entriesToResolverContent,
  findPrimaryResolverPath,
  loadSkillTriggerIndex,
} from './skill-trigger-index.ts';
import {
  indexResolverTriggers,
  lintRoutingFixtures,
  loadRoutingFixtures,
  runRoutingEval,
} from './routing-eval.ts';
import { findGbrainRoot, loadBundleManifest, bundledSkillSlugs } from './skillpack/bundle.ts';
import { diffSkill } from './skillpack/installer.ts';
import { getDefaultRegistry, type ResolverContext } from './resolvers/index.ts';
import { urlReachableResolver } from './resolvers/builtin/url-reachable.ts';
import { xHandleToTweetResolver } from './resolvers/builtin/x-api/handle-to-tweet.ts';
import { scanBrainSources } from './brain-writer.ts';
import { doctorReportRemote } from '../commands/doctor.ts';
import { recentlyModified, runSkillifyCheckTarget, type ResolverResult } from '../commands/skillify-check.ts';

function requireSkillsDir(): string {
  const detected = autoDetectSkillsDirReadOnly();
  if (!detected.dir) throw new Error('No skills directory could be auto-detected on this host.');
  return detected.dir;
}

function resolverRegistry() {
  const registry = getDefaultRegistry();
  for (const resolver of [urlReachableResolver, xHandleToTweetResolver]) {
    if (!registry.has(resolver.id)) registry.register(resolver as Parameters<typeof registry.register>[0]);
  }
  return registry;
}

function repoRoot(): string {
  return findGbrainRoot(process.cwd()) ?? process.cwd();
}

/** Resolve an existing regular file below the server's repository root. */
function confinedTarget(target: string): { root: string; absolute: string } {
  if (!target || isAbsolute(target)) throw new Error('target must be a non-empty relative path.');
  const root = realpathSync(repoRoot());
  const candidate = resolve(root, target);
  const rel = relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('target must stay within the server repository root.');
  }
  if (!existsSync(candidate) || lstatSync(candidate).isSymbolicLink()) {
    throw new Error('target must name an existing non-symlink file.');
  }
  const actual = realpathSync(candidate);
  const actualRel = relative(root, actual);
  if (actualRel.startsWith('..') || isAbsolute(actualRel)) {
    throw new Error('target resolves outside the server repository root.');
  }
  return { root, absolute: actual };
}

export function checkSkillTree() {
  const skillsDir = requireSkillsDir();
  const report = checkResolvable(skillsDir);
  return { ok: report.ok, skills_dir: skillsDir, report };
}

export function evaluateSkillRouting() {
  const skillsDir = requireSkillsDir();
  const entries = loadSkillTriggerIndex(skillsDir);
  const resolverFile = findPrimaryResolverPath(skillsDir);
  if (!resolverFile && entries.length === 0) {
    return { ok: false, skills_dir: skillsDir, error: 'no_resolver', report: null, lint_issues: [], malformed_fixtures: [] };
  }
  const resolverContent = entriesToResolverContent(entries);
  const loaded = loadRoutingFixtures(skillsDir);
  const index = indexResolverTriggers(resolverContent);
  const lintIssues = lintRoutingFixtures(loaded.fixtures, index);
  const report = runRoutingEval(resolverContent, loaded.fixtures);
  const ok = report.missed === 0 && report.ambiguous === 0 && report.falsePositives === 0 && lintIssues.length === 0 && loaded.malformed.length === 0;
  return {
    ok,
    skills_dir: skillsDir,
    resolver_file: resolverFile,
    report,
    lint_issues: lintIssues,
    malformed_fixtures: loaded.malformed,
  };
}

export function checkSkillify(target?: string, recent = false) {
  if (!target && !recent) throw new Error('Pass target or set recent=true.');
  if (target && recent) throw new Error('Pass either target or recent=true, not both.');
  if (recent) {
    const root = realpathSync(repoRoot());
    const resolverResult = checkSkillTreeResult(root);
    const results = recentlyModified(root).map(candidate => runSkillifyCheckTarget(candidate, root, resolverResult));
    return {
      recent: true,
      results: results.map(result => ({ ...result, path: relative(root, result.path) })),
    };
  }
  const { root, absolute } = confinedTarget(target!);
  const result = runSkillifyCheckTarget(absolute, root, checkSkillTreeResult(root));
  return {
    ...result,
    path: relative(root, absolute),
    items: result.items.map(item => ({
      ...item,
      detail: item.detail?.startsWith(root) ? relative(root, item.detail) : item.detail,
    })),
  };
}

function checkSkillTreeResult(root: string): ResolverResult {
  const report = checkResolvable(resolve(root, 'skills'));
  const count = report.errors.length + report.warnings.length;
  return {
    ok: report.ok,
    detail: report.ok ? 'all skill-tree checks pass' : `${count} issue(s) — run: voltmind check-resolvable`,
  };
}

export function listSkillpackSkills() {
  const root = repoRoot();
  const manifest = loadBundleManifest(root);
  return { name: manifest.name, version: manifest.version, skills: bundledSkillSlugs(manifest) };
}

export function diffSkillpackSkill(skill: string) {
  const root = repoRoot();
  const skillsDir = requireSkillsDir();
  const diffs = diffSkill(root, skill, skillsDir);
  return {
    skill,
    clean: diffs.every(diff => diff.existing && diff.identical),
    files: diffs.map(diff => ({
      path: relative(skillsDir, diff.target),
      existing: diff.existing,
      identical: diff.identical,
      source_bytes: diff.sourceBytes,
      target_bytes: diff.targetBytes,
    })),
  };
}

export async function getSkillpackHealth(engine: BrainEngine) {
  const doctor = await doctorReportRemote(engine);
  const failed = doctor.checks.filter(check => check.status === 'fail');
  const warnings = doctor.checks.filter(check => check.status === 'warn');
  return {
    healthy: failed.length === 0,
    summary: failed.length === 0 ? 'voltmind skillpack healthy' : `voltmind skillpack needs attention: ${failed.length} failing check(s)`,
    doctor,
    failed_checks: failed.map(check => check.name),
    warning_checks: warnings.map(check => check.name),
    note: 'MCP is diagnostic only; run remediation commands on the host CLI.',
  };
}

export function listResolvers(cost?: 'free' | 'rate-limited' | 'paid', backend?: string) {
  return resolverRegistry().list({ ...(cost ? { cost } : {}), ...(backend ? { backend } : {}) });
}

export async function describeResolver(id: string) {
  const registry = resolverRegistry();
  if (!registry.has(id)) throw new Error(`Resolver not found: ${id}`);
  const resolver = registry.get(id);
  const context: ResolverContext = {
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    requestId: 'mcp-describe-resolver',
    remote: true,
  };
  return {
    id: resolver.id,
    cost: resolver.cost,
    backend: resolver.backend,
    description: resolver.description,
    available: await resolver.available(context),
    input_schema: resolver.inputSchema,
    output_schema: resolver.outputSchema,
  };
}

export async function auditFrontmatter(engine: BrainEngine, sourceId: string) {
  return scanBrainSources(engine, { sourceId });
}
