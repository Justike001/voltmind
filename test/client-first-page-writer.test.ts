import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VoltMindConfig } from '../src/core/config.ts';
import { writeClientFirstPage } from '../src/core/client-first-page-writer.ts';

const VALID_PROJECT = `---
id: project-example
type: project
title: Example Project
owner: people/owner-slug
scope: private
visibility: private
sensitivity: internal
promotion: allowed
publish_level: candidate
source_refs: []
related_entities: []
created: 2026-08-05
updated: 2026-08-05
status: active
my_role: owner
team: orgs/team-slug
workstream: workstreams/workstream-slug
tracking_bindings: []
tracking_aliases: []
related_people: []
related_companies: []
related_systems: []
deadline: 2026-12-31
tags: []
---

# Example Project

当前状态说明。

<!-- voltmind:tracking-state:begin -->
## Tracked Current State

当前进展说明。
<!-- voltmind:tracking-state:end -->

## State
## Open Questions
## Decisions
## Commitments
## Risks
## Links

<!-- timeline -->

## Timeline

- **2026-08-05** | 项目模板合同已启用。[Source: 测试]
`;

let root: string;
let vault: string;
let previousHome: string | undefined;
let config: VoltMindConfig;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'voltmind-client-first-'));
  vault = join(root, 'vault');
  Bun.write(join(vault, '.keep'), '');
  previousHome = process.env.VOLTMIND_HOME;
  process.env.VOLTMIND_HOME = root;
  config = {
    engine: 'postgres',
    schema_pack: 'voltmind-personal-brain',
    client_vault_path: vault,
  };
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.VOLTMIND_HOME;
  else process.env.VOLTMIND_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

describe('client-first semantic page writer', () => {
  test('validates and persists the exact Markdown before remote synchronization', async () => {
    const receipt = await writeClientFirstPage(config, {
      slug: 'projects/example',
      content: VALID_PROJECT,
    });

    const target = join(vault, 'projects', 'example.md');
    expect(receipt.status).toBe('local_written_remote_pending');
    expect(receipt.path).toBe(target);
    expect(receipt.template_type).toBe('project');
    expect(receipt.content_sha256).toHaveLength(64);
    expect(readFileSync(target, 'utf8')).toBe(VALID_PROJECT);
  });

  test('rejects an invalid canonical page without touching the vault', async () => {
    const target = join(vault, 'projects', 'incomplete.md');
    await expect(writeClientFirstPage(config, {
      slug: 'projects/incomplete',
      content: '---\ntype: project\ntitle: Incomplete\n---\n\n# Incomplete\n',
    })).rejects.toMatchObject({
      code: 'template_contract_violation',
    });
    expect(existsSync(target)).toBe(false);
  });

  test('rejects path traversal before creating a file', async () => {
    await expect(writeClientFirstPage(config, {
      slug: '../outside',
      content: VALID_PROJECT,
    })).rejects.toMatchObject({ code: 'invalid_page_slug' });
    expect(existsSync(join(root, 'outside.md'))).toBe(false);
  });

  test('backs up an existing page and atomically replaces it', async () => {
    await writeClientFirstPage(config, { slug: 'projects/example', content: VALID_PROJECT });
    const updated = VALID_PROJECT.replace('当前状态说明。', '当前状态已经更新。');
    const receipt = await writeClientFirstPage(config, {
      slug: 'projects/example',
      content: updated,
    });

    expect(receipt.backup_path).toBeDefined();
    expect(readFileSync(receipt.backup_path!, 'utf8')).toBe(VALID_PROJECT);
    expect(readFileSync(receipt.path, 'utf8')).toBe(updated);
  });

  test('fails closed when the local vault is not configured', async () => {
    await expect(writeClientFirstPage({ engine: 'postgres' }, {
      slug: 'projects/example',
      content: VALID_PROJECT,
    })).rejects.toMatchObject({
      code: 'client_vault_not_configured',
    });
  });
});
