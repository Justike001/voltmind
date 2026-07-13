/**
 * Autopilot runtime status file (spec §9).
 *
 * `<VOLTMIND_HOME>/runtime/autopilot-status.json` is an atomically-written
 * local state file the autopilot daemon updates as it runs. This avoids
 * guessing status purely from process existence and lets `--status` report
 * DB connection, supervisor, and worker state.
 *
 * Rules (spec §9 / §20):
 *   - Atomic write (temp file + rename) to avoid half-written files.
 *   - No secrets.
 *   - Not synced to the database.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { voltmindPath } from '../config.ts';

export interface AutopilotRuntimeStatus {
  schemaVersion: number;
  pid: number;
  startedAt: string;
  updatedAt: string;
  repoPath: string;
  engine: 'postgres' | 'pglite';
  state: 'starting' | 'running' | 'degraded' | 'stopping' | 'failed';
  database: {
    state: 'unknown' | 'connecting' | 'connected' | 'error';
    lastConnectedAt?: string;
    lastError?: string;
  };
  supervisor: {
    state: 'disabled' | 'starting' | 'running' | 'restarting' | 'failed';
    workerExpected: boolean;
    workerPid?: number;
    restartCount: number;
    lastRestartAt?: string;
    lastError?: string;
  };
  heartbeatAt: string;
}

export const RUNTIME_STATUS_SCHEMA_VERSION = 1;

export function runtimeStatusDir(): string {
  return voltmindPath('runtime');
}

export function runtimeStatusPath(): string {
  return join(runtimeStatusDir(), 'autopilot-status.json');
}

function tmpPath(): string {
  return join(runtimeStatusDir(), '.autopilot-status.json.tmp');
}

/** Atomic write: write to temp then rename. */
export function writeRuntimeStatus(status: AutopilotRuntimeStatus): void {
  const dir = runtimeStatusDir();
  mkdirSync(dir, { recursive: true });
  const tmp = tmpPath();
  writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n');
  try {
    renameSync(tmp, runtimeStatusPath());
  } catch {
    // rename can fail across some FS; fall back to direct write.
    writeFileSync(runtimeStatusPath(), JSON.stringify(status, null, 2) + '\n');
    try { unlinkSync(tmp); } catch { /* best-effort */ }
  }
}

export function readRuntimeStatus(): AutopilotRuntimeStatus | null {
  const p = runtimeStatusPath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf-8');
    return JSON.parse(raw) as AutopilotRuntimeStatus;
  } catch {
    return null;
  }
}

export function deleteRuntimeStatus(): void {
  const p = runtimeStatusPath();
  if (existsSync(p)) {
    try { unlinkSync(p); } catch { /* best-effort */ }
  }
}

/**
 * Decide whether a heartbeat timestamp is stale (no update within the
 * threshold). Used by `--status` to detect a dead autopilot from its
 * heartbeat alone.
 */
export function isHeartbeatStale(heartbeatAt: string, staleMs: number): boolean {
  const ts = Date.parse(heartbeatAt);
  if (Number.isNaN(ts)) return true;
  return Date.now() - ts > staleMs;
}

/** Factory for an initial status record. */
export function initialRuntimeStatus(input: {
  pid: number;
  repoPath: string;
  engine: 'postgres' | 'pglite';
  workerExpected: boolean;
}): AutopilotRuntimeStatus {
  const now = new Date().toISOString();
  return {
    schemaVersion: RUNTIME_STATUS_SCHEMA_VERSION,
    pid: input.pid,
    startedAt: now,
    updatedAt: now,
    repoPath: input.repoPath,
    engine: input.engine,
    state: 'starting',
    database: { state: 'connecting' },
    supervisor: {
      state: input.workerExpected ? 'starting' : 'disabled',
      workerExpected: input.workerExpected,
      restartCount: 0,
    },
    heartbeatAt: now,
  };
}
