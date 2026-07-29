// Regression coverage for compiled thin-client runtimes. Schema manifests are
// YAML assets, so a runtime path join alone leaves every bundled pack absent
// from `bun build --compile` binaries.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const testDir = mkdtempSync(join(tmpdir(), 'voltmind-schema-pack-compiled-'));
const binaryPath = join(testDir, 'voltmind');
const homePath = join(testDir, 'home');

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('compiled schema packs', () => {
  test('loads the default bundled pack outside the source checkout', () => {
    const build = Bun.spawnSync([
      'bun', 'build', '--compile', '--outfile', binaryPath, join(repoRoot, 'src', 'cli.ts'),
    ], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
    expect(build.exitCode).toBe(0);

    const result = Bun.spawnSync([binaryPath, 'schema', 'active'], {
      cwd: testDir,
      env: { ...process.env, HOME: homePath, VOLTMIND_HOME: homePath },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain(
      'Active pack: voltmind-personal-brain',
    );
  }, 60_000);
});
