/**
 * Unit tests for the autopilot runtime status file (spec §9 / §16.1).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initialRuntimeStatus,
  writeRuntimeStatus,
  readRuntimeStatus,
  deleteRuntimeStatus,
  isHeartbeatStale,
  runtimeStatusPath,
} from '../src/core/autopilot/runtime-status.ts';
import type { AutopilotRuntimeStatus } from '../src/core/autopilot/runtime-status.ts';

let tmp: string;
const envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'voltmind-rtstatus-'));
  envSnapshot.VOLTMIND_HOME = process.env.VOLTMIND_HOME;
  process.env.VOLTMIND_HOME = tmp;
});

afterEach(() => {
  if (envSnapshot.VOLTMIND_HOME === undefined) delete process.env.VOLTMIND_HOME;
  else process.env.VOLTMIND_HOME = envSnapshot.VOLTMIND_HOME;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('runtime status file', () => {
  test('initialRuntimeStatus has correct shape for postgres + worker expected', () => {
    const s = initialRuntimeStatus({ pid: 123, repoPath: '/repo', engine: 'postgres', workerExpected: true });
    expect(s.schemaVersion).toBe(1);
    expect(s.state).toBe('starting');
    expect(s.engine).toBe('postgres');
    expect(s.supervisor.workerExpected).toBe(true);
    expect(s.supervisor.state).toBe('starting');
    expect(s.database.state).toBe('connecting');
  });

  test('initialRuntimeStatus disables supervisor when worker not expected', () => {
    const s = initialRuntimeStatus({ pid: 1, repoPath: '/r', engine: 'pglite', workerExpected: false });
    expect(s.supervisor.state).toBe('disabled');
    expect(s.supervisor.workerExpected).toBe(false);
  });

  test('write + read round-trips', () => {
    const s = initialRuntimeStatus({ pid: 42, repoPath: '/r', engine: 'postgres', workerExpected: true });
    writeRuntimeStatus(s);
    const loaded = readRuntimeStatus();
    expect(loaded).toEqual(s);
  });

  test('readRuntimeStatus returns null when absent', () => {
    expect(readRuntimeStatus()).toBeNull();
  });

  test('deleteRuntimeStatus is a no-op when absent', () => {
    expect(() => deleteRuntimeStatus()).not.toThrow();
  });

  test('isHeartbeatStale returns false for fresh heartbeat', () => {
    const fresh = new Date(Date.now() - 10_000).toISOString();
    expect(isHeartbeatStale(fresh, 120_000)).toBe(false);
  });

  test('isHeartbeatStale returns true for old heartbeat', () => {
    const old = new Date(Date.now() - 300_000).toISOString();
    expect(isHeartbeatStale(old, 120_000)).toBe(true);
  });

  test('isHeartbeatStale returns true for unparseable timestamp', () => {
    expect(isHeartbeatStale('not-a-date', 120_000)).toBe(true);
  });

  test('runtime status records the supervised worker PID separately from the parent PID', () => {
    const s = initialRuntimeStatus({ pid: 100, repoPath: '/r', engine: 'postgres', workerExpected: true });
    s.supervisor.workerPid = 200;
    s.supervisor.state = 'running';
    expect(s.pid).toBe(100);
    expect(s.supervisor.workerPid).toBe(200);
  });

  test('status file does not contain secrets', () => {
    const s: AutopilotRuntimeStatus = {
      ...initialRuntimeStatus({ pid: 1, repoPath: '/r', engine: 'postgres', workerExpected: true }),
      database: { state: 'error', lastError: 'role "x" does not exist' },
    };
    writeRuntimeStatus(s);
    const raw = require('fs').readFileSync(runtimeStatusPath(), 'utf-8');
    expect(raw).not.toMatch(/password|api[_-]?key|secret/i);
  });
});
