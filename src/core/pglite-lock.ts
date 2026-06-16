/**
 * PGLite File Lock — prevents concurrent process access to the same data directory.
 *
 * PGLite uses embedded Postgres (WASM) which only supports one connection at a time.
 * When `voltmind embed` (which can take minutes) is running and another process tries
 * to connect, PGLite throws `Aborted()` because it can't handle concurrent access.
 *
 * This module implements a simple advisory lock using a lock file next to the data
 * directory. It uses atomic `mkdir` (which is POSIX-atomic) combined with PID tracking
 * for stale lock detection.
 *
 * Usage:
 *   const lock = await acquireLock(dataDir);
 *   try { ... } finally { await releaseLock(lock); }
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { registerCleanup } from './process-cleanup.ts';

const LOCK_DIR_NAME = '.voltmind-lock';
const LOCK_FILE = 'lock';
const DEFAULT_STALE_THRESHOLD_MS = 30_000;
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 30_000;

export interface LockHandle {
  lockDir: string;
  acquired: boolean;
  deregisterCleanup?: () => void;
  heartbeat?: ReturnType<typeof setInterval>;
}

export interface PgliteLockInfo {
  lockDir: string;
  lockPath: string;
  exists: boolean;
  pid: number | null;
  acquiredAt: number | null;
  acquiredAtIso: string | null;
  lastSeenAt: number | null;
  lastSeenAtIso: string | null;
  ageMs: number | null;
  command: string | null;
  processAlive: boolean | null;
  stale: boolean;
  reason: 'missing' | 'dead_pid' | 'expired' | 'corrupt' | 'active';
  error?: string;
}

export interface PgliteUnlockResult {
  removed: boolean;
  info: PgliteLockInfo;
}

function getLockDir(dataDir: string | undefined): string {
  // Use the parent of the data dir for the lock, or a temp location for in-memory
  if (!dataDir) {
    // In-memory PGLite — no concurrent access possible since it's process-scoped
    // Return a sentinel that we skip
    return '';
  }
  return join(dataDir, LOCK_DIR_NAME);
}

function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 checks existence without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EPERM') return true;
    return false;
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function debugLog(message: string): void {
  if (process.env.VOLTMIND_PGLITE_LOCK_DEBUG !== '1') return;
  try { process.stderr.write(`[voltmind:pglite-lock] ${message}\n`); } catch { /* ignore */ }
}

export function getPgliteLockStaleThresholdMs(): number {
  return parsePositiveInt(process.env.VOLTMIND_PGLITE_STALE_MS, DEFAULT_STALE_THRESHOLD_MS);
}

export function getPgliteLockWaitTimeoutMs(): number {
  return parsePositiveInt(process.env.VOLTMIND_PGLITE_LOCK_TIMEOUT_MS, DEFAULT_LOCK_WAIT_TIMEOUT_MS);
}

function formatLockInfo(info: PgliteLockInfo): string {
  if (!info.exists) return `no lock at ${info.lockDir}`;
  if (info.reason === 'corrupt') {
    return `corrupt lock at ${info.lockDir}${info.error ? ` (${info.error})` : ''}`;
  }
  const pid = info.pid == null ? 'unknown' : String(info.pid);
  const since = info.acquiredAtIso ?? 'unknown time';
  const command = info.command || 'unknown command';
  const alive = info.processAlive === null ? 'unknown' : info.processAlive ? 'alive' : 'dead';
  const age = info.ageMs == null ? 'unknown age' : `${Math.round(info.ageMs / 1000)}s`;
  return `pid=${pid} (${alive}), since=${since}, age=${age}, command="${command}", lock=${info.lockDir}`;
}

export function inspectPgliteLock(dataDir: string | undefined, opts?: { nowMs?: number; staleMs?: number }): PgliteLockInfo {
  const lockDir = getLockDir(dataDir);
  const lockPath = lockDir ? join(lockDir, LOCK_FILE) : '';
  const base: PgliteLockInfo = {
    lockDir,
    lockPath,
    exists: false,
    pid: null,
    acquiredAt: null,
    acquiredAtIso: null,
    lastSeenAt: null,
    lastSeenAtIso: null,
    ageMs: null,
    command: null,
    processAlive: null,
    stale: false,
    reason: 'missing',
  };
  if (!lockDir || !existsSync(lockDir)) return base;

  try {
    const raw = readFileSync(lockPath, 'utf-8');
    const lockData = JSON.parse(raw) as { pid?: unknown; acquired_at?: unknown; last_seen_at?: unknown; command?: unknown };
    const pid = typeof lockData.pid === 'number' && Number.isFinite(lockData.pid) ? lockData.pid : null;
    const acquiredAt = typeof lockData.acquired_at === 'number' && Number.isFinite(lockData.acquired_at)
      ? lockData.acquired_at
      : null;
    const lastSeenAt = typeof lockData.last_seen_at === 'number' && Number.isFinite(lockData.last_seen_at)
      ? lockData.last_seen_at
      : acquiredAt;
    const now = opts?.nowMs ?? Date.now();
    const staleMs = opts?.staleMs ?? getPgliteLockStaleThresholdMs();
    const ageMs = lastSeenAt == null ? null : Math.max(0, now - lastSeenAt);
    const processAlive = pid == null ? null : isProcessAlive(pid);
    const expired = ageMs != null && ageMs > staleMs;
    const stale = processAlive === false || expired;
    return {
      ...base,
      exists: true,
      pid,
      acquiredAt,
      acquiredAtIso: acquiredAt == null ? null : new Date(acquiredAt).toISOString(),
      lastSeenAt,
      lastSeenAtIso: lastSeenAt == null ? null : new Date(lastSeenAt).toISOString(),
      ageMs,
      command: typeof lockData.command === 'string' ? lockData.command : null,
      processAlive,
      stale,
      reason: processAlive === false ? 'dead_pid' : expired ? 'expired' : 'active',
    };
  } catch (err) {
    return {
      ...base,
      exists: true,
      stale: true,
      reason: 'corrupt',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function clearPgliteLockIfStale(dataDir: string | undefined, opts?: { staleMs?: number }): PgliteUnlockResult {
  const info = inspectPgliteLock(dataDir, { staleMs: opts?.staleMs });
  if (!info.exists || !info.stale) {
    return { removed: false, info };
  }
  rmSync(info.lockDir, { recursive: true, force: true });
  return { removed: true, info };
}

/**
 * Attempt to acquire an exclusive lock on the PGLite data directory.
 * Returns { acquired: true } if the lock was obtained, { acquired: false } otherwise.
 * Stale locks (from dead processes) are automatically cleaned up.
 */
export async function acquireLock(dataDir: string | undefined, opts?: { timeoutMs?: number }): Promise<LockHandle> {
  const lockDir = getLockDir(dataDir);

  // In-memory PGLite — no lock needed (process-scoped, can't be shared)
  if (!lockDir) {
    return { lockDir: '', acquired: true };
  }

  // `lockDir` being set implies `dataDir` is set (see getLockDir), but TS
  // can't derive that across helper boundaries.
  mkdirSync(dataDir as string, { recursive: true });

  const timeoutMs = opts?.timeoutMs ?? getPgliteLockWaitTimeoutMs();
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    // Check for stale lock first
    if (existsSync(lockDir)) {
      const info = inspectPgliteLock(dataDir);
      if (info.stale) {
        try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* race condition, try again */ }
      } else {
        // Lock is held by a live process — wait and retry
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
    }

    // Try to acquire lock (atomic mkdir)
    try {
      mkdirSync(lockDir, { recursive: false });
      // We got the lock — write our PID
      const lockPath = join(lockDir, LOCK_FILE);
      writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        acquired_at: Date.now(),
        last_seen_at: Date.now(),
        command: process.argv.slice(1).join(' '),
      }), { mode: 0o644 });

      const handle: LockHandle = { lockDir, acquired: true };
      const heartbeatMs = Math.max(5_000, Math.min(10_000, Math.floor(getPgliteLockStaleThresholdMs() / 3)));
      handle.heartbeat = setInterval(() => {
        try {
          const raw = readFileSync(lockPath, 'utf-8');
          const data = JSON.parse(raw);
          if (data?.pid !== process.pid) return;
          data.last_seen_at = Date.now();
          writeFileSync(lockPath, JSON.stringify(data), { mode: 0o644 });
        } catch {
          /* The lock may already be released or stolen as stale. */
        }
      }, heartbeatMs);
      handle.heartbeat.unref?.();
      handle.deregisterCleanup = registerCleanup(`pglite-lock:${lockDir}`, async () => {
        try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort abnormal-exit cleanup */ }
      });
      debugLog(`acquired ${lockDir}`);
      return handle;
    } catch (e: unknown) {
      // mkdir failed — someone else grabbed it between our check and mkdir
      // This is fine, we'll retry
      if (Date.now() - startTime >= timeoutMs) {
        // Timeout — report which process holds the lock
        const info = inspectPgliteLock(dataDir);
        throw new Error(
          `VoltMind: Timed out waiting for PGLite lock after ${timeoutMs}ms. Holder: ${formatLockInfo(info)}. ` +
          `If this is stale, run: voltmind storage unlock-pglite --stale-only`
        );
      }
      // Brief wait before retry
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Should not reach here, but just in case
  const info = inspectPgliteLock(dataDir);
  throw new Error(
    `VoltMind: Timed out waiting for PGLite lock after ${timeoutMs}ms. Holder: ${formatLockInfo(info)}. ` +
    `If this is stale, run: voltmind storage unlock-pglite --stale-only`
  );
}

/**
 * Release a previously acquired lock.
 */
export async function releaseLock(lock: LockHandle): Promise<void> {
  if (!lock.lockDir || !lock.acquired) return;

  try {
    lock.deregisterCleanup?.();
    lock.deregisterCleanup = undefined;
    if (lock.heartbeat) {
      clearInterval(lock.heartbeat);
      lock.heartbeat = undefined;
    }
    rmSync(lock.lockDir, { recursive: true, force: true });
    debugLog(`released ${lock.lockDir}`);
  } catch {
    // Lock file already removed (e.g., by stale cleanup) — that's fine
  }
}
