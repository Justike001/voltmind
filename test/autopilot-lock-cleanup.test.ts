import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withEnv } from './helpers/with-env.ts';
import { removeStaleAutopilotLock } from '../src/commands/autopilot.ts';
import { voltmindPath } from '../src/core/config.ts';

describe('autopilot uninstall lock cleanup', () => {
  test('removes a lock whose owner PID is no longer alive', async () => {
    const home = mkdtempSync(join(tmpdir(), 'voltmind-autopilot-cleanup-'));
    await withEnv({ VOLTMIND_HOME: home }, async () => {
      mkdirSync(voltmindPath(), { recursive: true });
      const lockPath = voltmindPath('autopilot.lock');
      writeFileSync(lockPath, '2147483647\n');

      expect(removeStaleAutopilotLock()).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  test('keeps a lock whose owner PID is alive', async () => {
    const home = mkdtempSync(join(tmpdir(), 'voltmind-autopilot-live-lock-'));
    await withEnv({ VOLTMIND_HOME: home }, async () => {
      mkdirSync(voltmindPath(), { recursive: true });
      const lockPath = voltmindPath('autopilot.lock');
      writeFileSync(lockPath, `${process.pid}\n`);

      expect(removeStaleAutopilotLock()).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
    });
  });
});
