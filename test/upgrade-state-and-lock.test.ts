import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __testing as upgradeTesting,
  recordUpgradeError,
  runUpgrade,
  saveUpgradeState,
} from '../src/commands/upgrade.ts';
import { runSelfUpgrade } from '../src/commands/self-upgrade.ts';
import { VERSION } from '../src/version.ts';
import { withUpgradeLock } from '../src/core/self-upgrade.ts';
import { PackLockBusyError } from '../src/core/schema-pack/pack-lock.ts';
import { withEnv } from './helpers/with-env.ts';

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('upgrade state paths and durability', () => {
  test('honors VOLTMIND_HOME for state and error records', () => {
    root = mkdtempSync(join(tmpdir(), 'voltmind-upgrade-state-'));
    withEnv({ VOLTMIND_HOME: root }, () => {
      saveUpgradeState('1.2.3', '1.3.0');
      recordUpgradeError({
        phase: 'post-upgrade',
        fromVersion: '1.2.3',
        toVersion: '1.3.0',
        error: 'fixture failure',
        hint: 'retry fixture',
      });
    });

    const statePath = join(root, '.voltmind', 'upgrade-state.json');
    const errorsPath = join(root, '.voltmind', 'upgrade-errors.jsonl');
    expect(JSON.parse(readFileSync(statePath, 'utf8')).last_upgrade.to).toBe('1.3.0');
    expect(JSON.parse(readFileSync(errorsPath, 'utf8')).phase).toBe('post-upgrade');
    expect(readdirSync(join(root, '.voltmind')).some((name) => name.includes('.tmp.'))).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(statePath).mode & 0o777).toBe(0o600);
      expect(statSync(errorsPath).mode & 0o777).toBe(0o600);
    }
  });

  test('an interrupted atomic replace preserves the previous valid state', () => {
    root = mkdtempSync(join(tmpdir(), 'voltmind-upgrade-interrupt-'));
    const statePath = join(root, 'upgrade-state.json');
    writeFileSync(statePath, '{"last_upgrade":{"to":"1.2.3"}}\n');

    expect(() => upgradeTesting.atomicWritePrivate(
      statePath,
      '{"last_upgrade":{"to":"1.3.0"}}\n',
      () => { throw new Error('simulated interruption before rename'); },
    )).toThrow('simulated interruption');

    expect(JSON.parse(readFileSync(statePath, 'utf8')).last_upgrade.to).toBe('1.2.3');
    expect(readdirSync(root).some((name) => name.includes('.tmp.'))).toBe(false);
  });
});

describe('shared upgrade single-flight lock', () => {
  test('rejects a concurrent upgrade and releases for the next one', async () => {
    root = mkdtempSync(join(tmpdir(), 'voltmind-upgrade-lock-'));
    await withEnv({ VOLTMIND_HOME: root }, async () => {
      let release!: () => void;
      const held = withUpgradeLock(() => new Promise<void>((resolve) => { release = resolve; }));
      await Promise.resolve();
      await expect(withUpgradeLock(async () => undefined)).rejects.toBeInstanceOf(PackLockBusyError);
      release();
      await held;
      await expect(withUpgradeLock(async () => 'ok')).resolves.toBe('ok');
    });
  });

  test('ordinary help remains available while the upgrade lock is held', async () => {
    root = mkdtempSync(join(tmpdir(), 'voltmind-upgrade-help-'));
    await withEnv({ VOLTMIND_HOME: root }, async () => {
      let release!: () => void;
      const held = withUpgradeLock(() => new Promise<void>((resolve) => { release = resolve; }));
      await Promise.resolve();
      const output: string[] = [];
      const original = console.log;
      console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));
      try {
        await runUpgrade(['--help']);
      } finally {
        console.log = original;
        release();
      }
      await held;
      expect(output.join('\n')).toContain('Usage: voltmind upgrade');
      expect(existsSync(join(root!, '.voltmind', '.locks', 'self-upgrade.lock'))).toBe(false);
    });
  });

  test('direct upgrade and self-upgrade package paths share the same mutex', async () => {
    root = mkdtempSync(join(tmpdir(), 'voltmind-upgrade-entrypoints-'));
    await withEnv({ VOLTMIND_HOME: root }, async () => {
      let release!: () => void;
      let firstEntered = false;
      let secondEntered = false;
      const first = runUpgrade([], {
        lockedAction: () => new Promise<void>((resolve) => {
          firstEntered = true;
          release = resolve;
        }),
      });
      while (!firstEntered) await Promise.resolve();

      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
      try {
        await runSelfUpgrade(['--force'], {
          fetchLatestRelease: async () => ({
            tag: `v${VERSION}`,
            published_at: '2026-08-17T00:00:00Z',
            url: 'https://example.invalid/release',
          }),
          runUpgrade: (args) => runUpgrade(args, {
            lockedAction: () => { secondEntered = true; },
          }),
        });
      } finally {
        console.error = originalError;
        release();
      }
      await first;

      expect(secondEntered).toBe(false);
      expect(errors.join('\n')).toContain('already in progress');
    });
  });

  test('reclaims a stale upgrade lock left by a dead process', async () => {
    root = mkdtempSync(join(tmpdir(), 'voltmind-upgrade-stale-'));
    await withEnv({ VOLTMIND_HOME: root }, async () => {
      const lockDir = join(root!, '.voltmind', '.locks');
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, 'self-upgrade.lock'), JSON.stringify({
        pid: 424242,
        hostname: 'fixture',
        ts: 1,
        ttlMs: 10 * 60_000,
      }));
      await expect(withUpgradeLock(async () => 'reclaimed', {
        now: () => 2,
        isPidAlive: () => false,
      })).resolves.toBe('reclaimed');
      expect(existsSync(join(lockDir, 'self-upgrade.lock'))).toBe(false);
    });
  });
});
