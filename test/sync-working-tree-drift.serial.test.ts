import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasSyncableWorkingTreeDrift } from '../src/core/sync-delta.ts';

describe('hasSyncableWorkingTreeDrift', () => {
  test('true only for syncable uncommitted files (.sources pruned)', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'voltmind-drift-'));
    try {
      execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 'voltmind-test@example.invalid'], { cwd: repoPath });
      execFileSync('git', ['config', 'user.name', 'VoltMind Test'], { cwd: repoPath });
      mkdirSync(join(repoPath, 'people'), { recursive: true });
      writeFileSync(join(repoPath, 'people/a.md'), '---\ntype: person\ntitle: A\n---\na\n');
      execFileSync('git', ['add', '-A'], { cwd: repoPath, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath, stdio: 'pipe' });

      expect(hasSyncableWorkingTreeDrift(repoPath)).toBe(false);

      writeFileSync(join(repoPath, 'people/b.md'), '---\ntype: person\ntitle: B\n---\nb\n');
      expect(hasSyncableWorkingTreeDrift(repoPath)).toBe(true);

      rmSync(join(repoPath, 'people/b.md'));
      mkdirSync(join(repoPath, '.sources', 'v'), { recursive: true });
      writeFileSync(join(repoPath, '.sources', 'v', 'c.md'), 'c');
      expect(hasSyncableWorkingTreeDrift(repoPath)).toBe(false);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
