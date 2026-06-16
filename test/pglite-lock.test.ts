import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  acquireLock,
  clearPgliteLockIfStale,
  inspectPgliteLock,
  releaseLock,
  getPgliteLockStaleThresholdMs,
} from '../src/core/pglite-lock.ts';
import {
  _registeredCleanupCountForTests,
  _resetForTests,
} from '../src/core/process-cleanup.ts';

let root: string;
let oldStale: string | undefined;
let oldTimeout: string | undefined;

beforeEach(() => {
  root = join(tmpdir(), `voltmind-pglite-lock-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  oldStale = process.env.VOLTMIND_PGLITE_STALE_MS;
  oldTimeout = process.env.VOLTMIND_PGLITE_LOCK_TIMEOUT_MS;
  delete process.env.VOLTMIND_PGLITE_STALE_MS;
  delete process.env.VOLTMIND_PGLITE_LOCK_TIMEOUT_MS;
  _resetForTests();
});

afterEach(() => {
  if (oldStale === undefined) delete process.env.VOLTMIND_PGLITE_STALE_MS;
  else process.env.VOLTMIND_PGLITE_STALE_MS = oldStale;
  if (oldTimeout === undefined) delete process.env.VOLTMIND_PGLITE_LOCK_TIMEOUT_MS;
  else process.env.VOLTMIND_PGLITE_LOCK_TIMEOUT_MS = oldTimeout;
  rmSync(root, { recursive: true, force: true });
  _resetForTests();
});

function writeLock(dataDir: string, payload: Record<string, unknown>): string {
  const lockDir = join(dataDir, '.voltmind-lock');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'lock'), JSON.stringify(payload));
  return lockDir;
}

describe('PGLite file lock', () => {
  test('creates missing data directory before acquiring lock', async () => {
    const missingDataDir = join(root, 'missing-data-dir');

    const lock = await acquireLock(missingDataDir);
    expect(lock.acquired).toBe(true);
    expect(existsSync(missingDataDir)).toBe(true);
    expect(existsSync(join(missingDataDir, '.voltmind-lock'))).toBe(true);

    await releaseLock(lock);
    expect(existsSync(join(missingDataDir, '.voltmind-lock'))).toBe(false);
  });

  test('registers abnormal-exit cleanup and deregisters on release', async () => {
    const lock = await acquireLock(root);
    expect(existsSync(join(root, '.voltmind-lock'))).toBe(true);
    expect(_registeredCleanupCountForTests()).toBe(1);

    await releaseLock(lock);

    expect(existsSync(join(root, '.voltmind-lock'))).toBe(false);
    expect(_registeredCleanupCountForTests()).toBe(0);
  });

  test('prevents concurrent lock acquisition', async () => {
    process.env.VOLTMIND_PGLITE_STALE_MS = '60000';
    const lock = await acquireLock(root);

    await expect(acquireLock(root, { timeoutMs: 5 })).rejects.toThrow(/Timed out/);

    await releaseLock(lock);
  });

  test('skips lock for in-memory PGLite', async () => {
    const lock = await acquireLock(undefined);
    expect(lock.acquired).toBe(true);
    expect(lock.lockDir).toBe('');

    await releaseLock(lock);
  });

  test('stale threshold is controlled by VOLTMIND_PGLITE_STALE_MS', () => {
    process.env.VOLTMIND_PGLITE_STALE_MS = '15000';
    expect(getPgliteLockStaleThresholdMs()).toBe(15000);
  });

  test('lock file contains PID and command', async () => {
    const lock = await acquireLock(root);
    const lockData = JSON.parse(readFileSync(join(root, '.voltmind-lock', 'lock'), 'utf-8'));

    expect(lockData.pid).toBe(process.pid);
    expect(lockData.acquired_at).toBeDefined();
    expect(lockData.command).toBeDefined();

    await releaseLock(lock);
  });

  test('inspect reports holder PID command path and active state', () => {
    writeLock(root, {
      pid: process.pid,
      acquired_at: Date.now(),
      command: 'voltmind embed --stale',
    });

    const info = inspectPgliteLock(root);

    expect(info.exists).toBe(true);
    expect(info.lockDir).toBe(join(root, '.voltmind-lock'));
    expect(info.pid).toBe(process.pid);
    expect(info.processAlive).toBe(true);
    expect(info.stale).toBe(false);
    expect(info.command).toBe('voltmind embed --stale');
  });

  test('unlock stale-only removes dead PID locks', () => {
    const lockDir = writeLock(root, {
      pid: 99999999,
      acquired_at: Date.now(),
      command: 'voltmind import brain',
    });

    const result = clearPgliteLockIfStale(root);

    expect(result.removed).toBe(true);
    expect(result.info.reason).toBe('dead_pid');
    expect(existsSync(lockDir)).toBe(false);
  });

  test('unlock stale-only removes expired locks and leaves fresh live locks', () => {
    process.env.VOLTMIND_PGLITE_STALE_MS = '15000';
    const lockDir = writeLock(root, {
      pid: process.pid,
      acquired_at: Date.now() - 16_000,
      command: 'voltmind search q',
    });

    const expired = clearPgliteLockIfStale(root);
    expect(expired.removed).toBe(true);
    expect(expired.info.reason).toBe('expired');
    expect(existsSync(lockDir)).toBe(false);

    writeLock(root, {
      pid: process.pid,
      acquired_at: Date.now(),
      command: 'voltmind search q',
    });
    const fresh = clearPgliteLockIfStale(root);
    expect(fresh.removed).toBe(false);
    expect(fresh.info.reason).toBe('active');
    expect(existsSync(join(root, '.voltmind-lock'))).toBe(true);
  });

  test('timeout error includes holder details and unlock hint', async () => {
    process.env.VOLTMIND_PGLITE_STALE_MS = '60000';
    writeLock(root, {
      pid: process.pid,
      acquired_at: Date.now(),
      command: 'voltmind import brain',
    });

    let message = '';
    try {
      await acquireLock(root, { timeoutMs: 5 });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain('Timed out waiting for PGLite lock');
    expect(message).toContain(String(process.pid));
    expect(message).toContain('voltmind import brain');
    expect(message).toContain('voltmind storage unlock-pglite --stale-only');
    const raw = readFileSync(join(root, '.voltmind-lock', 'lock'), 'utf-8');
    expect(raw).toContain('voltmind import brain');
  });
});
