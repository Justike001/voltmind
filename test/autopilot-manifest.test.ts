/**
 * Unit tests for the autopilot install manifest (spec §6 / §16.1).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadManifest,
  saveManifest,
  deleteManifest,
  createManifest,
  reconcileManifest,
  manifestPath,
  MANIFEST_SCHEMA_VERSION,
} from '../src/core/autopilot/manifest.ts';
import type { AutopilotInstallManifest } from '../src/core/autopilot/manifest.ts';

let tmp: string;
const envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'voltmind-manifest-'));
  envSnapshot.VOLTMIND_HOME = process.env.VOLTMIND_HOME;
  process.env.VOLTMIND_HOME = tmp;
});

afterEach(() => {
  if (envSnapshot.VOLTMIND_HOME === undefined) delete process.env.VOLTMIND_HOME;
  else process.env.VOLTMIND_HOME = envSnapshot.VOLTMIND_HOME;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const baseManifest: AutopilotInstallManifest = {
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  installVersion: '0.41.20.0',
  target: 'windows-task',
  repoPath: 'C:\\Users\\alice\\brain',
  cliInvocation: { executable: 'C:\\voltmind\\voltmind.exe', prefixArgs: [], source: 'native-exe' },
  runtimeEnvFile: 'C:\\Users\\alice\\.voltmind\\runtime.env',
  scheduler: { taskName: 'VoltMind Autopilot' },
  installedAt: '2026-01-01T00:00:00.000Z',
  reconciledAt: '2026-01-01T00:00:00.000Z',
};

describe('manifest', () => {
  test('createManifest sets schemaVersion + timestamps', () => {
    const m = createManifest({
      target: 'macos',
      repoPath: '/home/alice/brain',
      cliInvocation: { executable: '/bin/voltmind', prefixArgs: [], source: 'unix-binary' },
      installVersion: '1.0.0',
    });
    expect(m.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(m.installedAt).toBe(m.reconciledAt);
    expect(m.target).toBe('macos');
  });

  test('save + load round-trips', () => {
    saveManifest(baseManifest);
    const loaded = loadManifest();
    expect(loaded).toEqual(baseManifest);
  });

  test('loadManifest returns null when absent', () => {
    expect(loadManifest()).toBeNull();
  });

  test('deleteManifest is a no-op when absent', () => {
    expect(() => deleteManifest()).not.toThrow();
  });

  test('idempotent install: re-saving preserves target + repo', () => {
    saveManifest(baseManifest);
    const reconciled = reconcileManifest(baseManifest, {});
    saveManifest(reconciled);
    expect(loadManifest()?.target).toBe('windows-task');
    expect(loadManifest()?.repoPath).toBe('C:\\Users\\alice\\brain');
  });

  test('reconcile updates version + cliInvocation without changing target intent', () => {
    saveManifest(baseManifest);
    const existing = loadManifest()!;
    const reconciled = reconcileManifest(existing, {
      installVersion: '0.42.0.0',
      cliInvocation: { executable: 'C:\\voltmind\\voltmind2.exe', prefixArgs: [], source: 'native-exe' },
    });
    saveManifest(reconciled);
    const loaded = loadManifest()!;
    expect(loaded.installVersion).toBe('0.42.0.0');
    expect(loaded.cliInvocation.executable).toBe('C:\\voltmind\\voltmind2.exe');
    // Target intent (user's "is autopilot enabled") is unchanged.
    expect(loaded.target).toBe('windows-task');
  });

  test('reconcile updates repo path', () => {
    saveManifest(baseManifest);
    const reconciled = reconcileManifest(loadManifest()!, { repoPath: 'D:\\new\\brain' });
    saveManifest(reconciled);
    expect(loadManifest()?.repoPath).toBe('D:\\new\\brain');
  });

  test('reconcile updates runtime env file path', () => {
    saveManifest(baseManifest);
    const reconciled = reconcileManifest(loadManifest()!, { runtimeEnvFile: 'D:\\env.env' });
    saveManifest(reconciled);
    expect(loadManifest()?.runtimeEnvFile).toBe('D:\\env.env');
  });

  test('manifest does not contain secret values (only env file path)', () => {
    saveManifest(baseManifest);
    const raw = require('fs').readFileSync(manifestPath(), 'utf-8');
    expect(raw).toContain('runtime.env');
    expect(raw).not.toMatch(/password|secret|api[_-]?key/i);
  });

  test('reconcile never creates a manifest when none exists (returns object, but caller gates)', () => {
    // reconcileManifest requires an existing manifest; it does not create.
    // This test documents that contract: passing a hand-built existing is fine,
    // but the install path must create via createManifest first.
    const existing = baseManifest;
    const r = reconcileManifest(existing, { repoPath: '/x' });
    expect(r.repoPath).toBe('/x');
  });
});
