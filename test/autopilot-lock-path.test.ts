/**
 * v0.37.7.0 #1226 regression test.
 *
 * The autopilot lockfile was hardcoded at `~/.voltmind/autopilot.lock`
 * (via `process.env.HOME`), bypassing VOLTMIND_HOME. Two brains pointed
 * at different VOLTMIND_HOME directories would still write to the same
 * global lockfile; one would silently take over the other on each
 * restart.
 *
 * Fix: route through `voltmindPath('autopilot.lock')` which honors
 * VOLTMIND_HOME. This file pins the contract via the canonical helper
 * directly, since the autopilot daemon's lifecycle is heavy to drive
 * in a unit test.
 */

import { describe, test, expect } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { voltmindPath } from '../src/core/config.ts';

describe('autopilot lock path scoped to VOLTMIND_HOME (#1226)', () => {
  test('one VOLTMIND_HOME produces one canonical lock path', async () => {
    const home = mkdtempSync(join(tmpdir(), 'voltmind-autopilot-lock-'));
    await withEnv({ VOLTMIND_HOME: home }, async () => {
      const lockPath = voltmindPath('autopilot.lock');
      // Lockfile MUST live inside the per-brain VOLTMIND_HOME, not under
      // process.env.HOME — that was the pre-fix bug.
      expect(lockPath.startsWith(home)).toBe(true);
      expect(lockPath.endsWith('autopilot.lock')).toBe(true);
    });
  });

  test('two VOLTMIND_HOME values produce two distinct lockfiles', async () => {
    const homeA = mkdtempSync(join(tmpdir(), 'voltmind-autopilot-A-'));
    const homeB = mkdtempSync(join(tmpdir(), 'voltmind-autopilot-B-'));

    let lockA = '';
    let lockB = '';
    await withEnv({ VOLTMIND_HOME: homeA }, async () => {
      lockA = voltmindPath('autopilot.lock');
    });
    await withEnv({ VOLTMIND_HOME: homeB }, async () => {
      lockB = voltmindPath('autopilot.lock');
    });

    // The contract that prevents two brains from silently colliding:
    // distinct VOLTMIND_HOME values MUST produce distinct lockfile paths.
    expect(lockA).not.toBe(lockB);
    expect(lockA.startsWith(homeA)).toBe(true);
    expect(lockB.startsWith(homeB)).toBe(true);
  });

  test('default (no VOLTMIND_HOME override) still produces a valid path', async () => {
    // When VOLTMIND_HOME is unset, voltmindPath falls through to its
    // default (`~/.voltmind`). The path must still exist as a string
    // and end with the expected filename — we don't assert the exact
    // home dir since that varies by environment.
    await withEnv({ VOLTMIND_HOME: undefined }, async () => {
      const lockPath = voltmindPath('autopilot.lock');
      expect(typeof lockPath).toBe('string');
      expect(lockPath.endsWith('autopilot.lock')).toBe(true);
      expect(lockPath.length).toBeGreaterThan('autopilot.lock'.length);
    });
  });
});
