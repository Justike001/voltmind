import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { operations } from '../src/core/operations.ts';
import { normalizeText } from '../src/core/routing-eval.ts';
import { parseSkillFrontmatter } from '../src/core/skill-frontmatter.ts';

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const frontmatter = (path: string) => {
  const parsed = parseSkillFrontmatter(read(path));
  if (!parsed) throw new Error(`Missing frontmatter: ${path}`);
  return parsed;
};
const operationNames = new Set(operations.map(operation => operation.name));

describe('external-file runtime skill injection', () => {
  test('ingest routes mapped-drive setup and declares executable Host operations', () => {
    const skill = frontmatter('skills/ingest/SKILL.md');
    expect(skill.triggers).toContain('configure shared drive');
    expect(skill.triggers).toContain('configure raidrive');
    expect(skill.triggers).toContain('map z drive');
    for (const tool of [
      'search_file_refs',
      'list_page_file_refs',
      'attach_file_refs',
      'file_ref_materialize',
    ]) {
      expect(skill.tools).toContain(tool);
      expect(operationNames.has(tool)).toBe(true);
    }
    const body = read('skills/ingest/SKILL.md');
    const mappedDrive = read('skills/ingest/references/mapped-shared-drive.md');
    expect(body).toContain('(references/mapped-shared-drive.md)');
    expect(mappedDrive).toContain('voltmind client-roots add synology-public');
    expect(mappedDrive).toContain('voltmind client-roots test synology-public');
    expect(mappedDrive).toContain("voltmind file-refs search 'Z:\\Public\\Finance\\example.xlsx'");
    expect(mappedDrive).toContain('Never run\n`client-roots` through remote MCP');
  });

  test('cold-start exposes file-reference operations to tool-filtering harnesses', () => {
    const skill = frontmatter('skills/cold-start/SKILL.md');
    for (const tool of [
      'search_file_refs',
      'list_page_file_refs',
      'attach_file_refs',
      'file_ref_materialize',
    ]) {
      expect(skill.tools).toContain(tool);
      expect(operationNames.has(tool)).toBe(true);
    }
  });

  test('maintenance routes and declares source-scoped backfill and scrub operations', () => {
    const skill = frontmatter('skills/maintain/SKILL.md');
    expect(skill.triggers).toContain('backfill file references');
    expect(skill.triggers).toContain('scrub open paths');
    for (const tool of ['search_file_refs', 'backfill_file_refs', 'scrub_file_ref_open_paths']) {
      expect(skill.tools).toContain(tool);
      expect(operationNames.has(tool)).toBe(true);
    }
  });

  test('client maintenance reference keeps client-authorized backfill/scrub and rejects host reconcile', () => {
    const body = read('skills/maintain/references/client.md');
    expect(body).toContain('backfill_file_refs');
    expect(body).toContain('scrub_file_ref_open_paths');
    expect(body).toContain('reconcile_project_tracking` / `voltmind projects tracking reconcile`');
    expect(body).toContain('admin-scope + company-server-only');
    expect(body).toContain('VOLTMIND_RUNTIME_ROLE');
    expect(body).toContain('Host work request');
    expect(body).toContain('local semantic vault');
    expect(body).toContain('newest-first');
    expect(body).toContain('local_written_remote_pending');
  });

  test('main maintenance publishes the full runtime operation union and routes Host detail to a reference', () => {
    const skill = frontmatter('skills/maintain/SKILL.md');
    for (const tool of ['reconcile_project_tracking', 'get_project_tracking_status', 'backfill_file_refs', 'scrub_file_ref_open_paths', 'run_doctor']) {
      expect(skill.tools).toContain(tool);
      expect(operationNames.has(tool)).toBe(true);
    }
    const body = read('skills/maintain/references/host.md');
    expect(body).toContain('VOLTMIND_RUNTIME_ROLE');
  });

  test('client root mutation remains discoverable CLI-only client file-plane work', () => {
    expect(operationNames.has('client_roots')).toBe(false);
    const cli = read('src/cli.ts');
    expect(cli).toContain("'client-roots'");
    expect(cli).toContain("if (command === 'client-roots')");
    const resolver = read('skills/RESOLVER.md');
    expect(resolver).toContain('client-roots` runs only on the thin-client workstation');
  });

  test('cold-start ships in the bundled agent skill catalog', () => {
    const manifest = JSON.parse(read('openclaw.plugin.json')) as { skills: string[] };
    expect(manifest.skills).toContain('skills/cold-start');
  });

  test('structural routing preserves CJK triggers', () => {
    expect(normalizeText('请配置共享盘，让客户端可用')).toContain('配置共享盘');
  });
});
