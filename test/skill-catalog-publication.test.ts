import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BrainEngine } from '../src/core/engine.ts';
import { KNOWN_CONFIG_KEYS, KNOWN_CONFIG_KEY_PREFIXES } from '../src/core/config.ts';
import {
  getPublishedSkill,
  listPublishedSkills,
  SkillCatalogError,
  type SkillCatalogContext,
} from '../src/core/skill-catalog.ts';
import {
  OperationError,
  operations,
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(entries: Array<{ name: string; path?: string; description?: string }> = [{ name: 'project' }]) {
  const root = mkdtempSync(join(tmpdir(), 'voltmind-skill-catalog-'));
  roots.push(root);
  const skillsDir = join(root, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(skillsDir, 'RESOLVER.md'), '# Resolver\n', 'utf8');
  for (const entry of entries) {
    if (entry.path) continue;
    const dir = join(skillsDir, entry.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---
name: ${entry.name}
description: Maintain project tracking.
triggers:
  - "project tracking"
tools:
  - search
  - reconcile_project_tracking
  - local_only_example
mutating: true
writes_pages: true
writes_to:
  - projects/
sources:
  - private.md
---

# Project

Follow the Host workflow.
`, 'utf8');
  }
  writeFileSync(join(skillsDir, 'manifest.json'), JSON.stringify({
    skills: entries.map(entry => ({
      name: entry.name,
      path: entry.path ?? `${entry.name}/SKILL.md`,
      ...(entry.description ? { description: entry.description } : {}),
    })),
  }), 'utf8');
  return { root, skillsDir };
}

function context(skillsDir: string, values: Record<string, string | null>, overrides: Partial<SkillCatalogContext> = {}): SkillCatalogContext {
  const engine = {
    getConfig: async (key: string) => values[key] ?? null,
  } as unknown as BrainEngine;
  return {
    engine,
    config: { engine: 'postgres' },
    remote: true,
    grantedScopes: ['read'],
    cwd: skillsDir,
    env: { VOLTMIND_SKILLS_DIR: skillsDir },
    ...overrides,
  };
}

describe('Host skill publication', () => {
  test('remote publication is default-off even when a skills directory exists', async () => {
    const { skillsDir } = fixture();
    await expect(listPublishedSkills(context(skillsDir, {}))).rejects.toMatchObject({
      code: 'permission_denied',
    });
  });

  test('DB config enables a manifest-backed catalog and preserves manifest descriptions', async () => {
    const { skillsDir } = fixture([{ name: 'project', description: 'Published project workflow.' }]);
    const result = await listPublishedSkills(context(skillsDir, {
      'mcp.publish_skills': 'true',
      'mcp.skills_dir': skillsDir,
    }));
    expect(result).toEqual({
      derived_manifest: false,
      skills: [{ name: 'project', description: 'Published project workflow.' }],
    });
  });

  test('get_skill returns prose, safe frontmatter, and caller-usable tool honesty', async () => {
    const { skillsDir } = fixture();
    const result = await getPublishedSkill(context(skillsDir, {
      'mcp.publish_skills': 'true',
      'mcp.skills_dir': skillsDir,
    }), 'project', [
      { name: 'search', scope: 'read' },
      { name: 'reconcile_project_tracking', scope: 'admin' },
      { name: 'local_only_example', scope: 'read', localOnly: true },
    ]);
    expect(result.content).toContain('# Project');
    expect(result.content).not.toContain('writes_to:');
    expect(result.content).not.toContain('sources:');
    expect(result.frontmatter).toEqual({
      name: 'project',
      triggers: ['project tracking'],
      tools: ['search', 'reconcile_project_tracking', 'local_only_example'],
      mutating: true,
      writes_pages: true,
    });
    expect(result.frontmatter).not.toHaveProperty('writes_to');
    expect(result.frontmatter).not.toHaveProperty('sources');
    expect(result.tools.usable).toEqual(['search']);
    expect(result.tools.unavailable).toEqual(['reconcile_project_tracking', 'local_only_example']);
  });

  test('rejects traversal-shaped names before filesystem access', async () => {
    const { skillsDir } = fixture();
    await expect(getPublishedSkill(context(skillsDir, {
      'mcp.publish_skills': 'true',
      'mcp.skills_dir': skillsDir,
    }), '../project', [])).rejects.toBeInstanceOf(SkillCatalogError);
  });

  test('fails closed when a manifest path escapes the published skills root', async () => {
    const { root, skillsDir } = fixture([{ name: 'project', path: '../outside/SKILL.md' }]);
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'SKILL.md'), '# secret\n', 'utf8');
    await expect(listPublishedSkills(context(skillsDir, {
      'mcp.publish_skills': 'true',
      'mcp.skills_dir': skillsDir,
    }))).rejects.toMatchObject({ code: 'storage_error' });
  });

  test('get_skill validates unrelated manifest entries before returning prose', async () => {
    const { root, skillsDir } = fixture([
      { name: 'project' },
      { name: 'poisoned', path: '../outside/SKILL.md' },
    ]);
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'SKILL.md'), '# secret\n', 'utf8');
    await expect(getPublishedSkill(context(skillsDir, {
      'mcp.publish_skills': 'true',
      'mcp.skills_dir': skillsDir,
    }), 'project', [])).rejects.toMatchObject({ code: 'storage_error' });
  });

  test('local callers may inspect skills while the remote publish gate is off', async () => {
    const { skillsDir } = fixture();
    const result = await listPublishedSkills(context(skillsDir, {}, { remote: false }));
    expect(result.skills.map(skill => skill.name)).toEqual(['project']);
  });

  test('canonical operations and generated MCP tools expose list_skills/get_skill as read-only tools', () => {
    expect(operationsByName.list_skills?.scope).toBe('read');
    expect(operationsByName.get_skill?.scope).toBe('read');
    expect(operationsByName.list_skills?.localOnly).toBe(false);
    expect(operationsByName.get_skill?.localOnly).toBe(false);
    expect(operationsByName.list_skills?.cliHints).toEqual({ name: 'skills' });
    expect(operationsByName.get_skill?.cliHints).toEqual({ name: 'skill', positional: ['name'] });
    const names = buildToolDefs(operations).map(tool => tool.name);
    expect(names).toContain('list_skills');
    expect(names).toContain('get_skill');
  });

  test('config discovery accepts Host publication keys without --force', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('mcp.publish_skills');
    expect(KNOWN_CONFIG_KEYS).toContain('mcp.skills_dir');
    expect(KNOWN_CONFIG_KEY_PREFIXES).toContain('mcp.');
  });

  test('operation handlers preserve the default-off permission error', async () => {
    const { skillsDir } = fixture();
    const catalogContext = context(skillsDir, {});
    const operationContext = {
      engine: catalogContext.engine,
      config: catalogContext.config,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      dryRun: false,
      remote: true,
      sourceId: 'default',
      auth: { clientId: 'test-client', scopes: ['read'] },
    } as unknown as OperationContext;

    try {
      await operationsByName.list_skills.handler(operationContext, {});
      throw new Error('expected list_skills to reject while publication is disabled');
    } catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      expect(error).toMatchObject({ code: 'permission_denied' });
    }
  });
});
