import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultPersonalBrainRoot,
  installPersonalBrainScaffold,
} from '../src/core/personal-brain-scaffold.ts';

describe('VoltMind Personal Brain scaffold', () => {
  test('default root is ./brain under the current workspace', () => {
    expect(defaultPersonalBrainRoot('/tmp/example').replace(/\\/g, '/')).toBe('/tmp/example/brain');
  });

  test('installs Phase 0/1 scaffold additively', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'voltmind-personal-brain-'));
    try {
      const root = join(tmp, 'brain');
      const result = installPersonalBrainScaffold(root);
      expect(result.root).toBe(root);
      expect(result.createdFiles.length).toBeGreaterThan(0);
      expect(existsSync(join(root, 'RESOLVER.md'))).toBe(true);
      expect(existsSync(join(root, 'index.md'))).toBe(true);
      expect(existsSync(join(root, 'schema.md'))).toBe(true);
      expect(existsSync(join(root, 'policy', 'privacy-policy.md'))).toBe(true);
      expect(existsSync(join(root, '.system', 'policy-config.json'))).toBe(true);
      expect(existsSync(join(root, 'policies'))).toBe(false);

      const config = JSON.parse(readFileSync(join(root, '.system', 'policy-config.json'), 'utf-8'));
      expect(config.publish_levels).toEqual([
        'never',
        'candidate',
        'user_approved',
        'team_reviewed',
        'company_state',
      ]);
      expect(config.sensitivity).toEqual(['public', 'internal', 'confidential', 'restricted']);
      expect(config.action_risk).toEqual(['low', 'medium', 'high', 'restricted']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('does not overwrite existing user files on re-run', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'voltmind-personal-brain-'));
    try {
      const root = join(tmp, 'brain');
      installPersonalBrainScaffold(root);
      writeFileSync(join(root, 'RESOLVER.md'), '# Custom Resolver\n', 'utf-8');
      const second = installPersonalBrainScaffold(root);
      expect(readFileSync(join(root, 'RESOLVER.md'), 'utf-8')).toBe('# Custom Resolver\n');
      expect(second.skippedFiles).toContain('RESOLVER.md');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
