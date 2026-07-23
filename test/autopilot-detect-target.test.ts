/**
 * Unit tests for install-target detection (spec §2.2 / §16.1).
 */

import { describe, test, expect } from 'bun:test';
import { detectInstallTarget } from '../src/core/autopilot/detect-target.ts';
import { isInstallTarget, ALL_INSTALL_TARGETS } from '../src/core/autopilot/diagnostics.ts';

describe('detectInstallTarget (unified)', () => {
  test('win32 -> windows-task', () => {
    const r = detectInstallTarget({ platform: 'win32' as NodeJS.Platform, env: {} });
    expect(r.target).toBe('windows-task');
  });

  test('win32 does NOT fall back to linux-cron even with no env signals', () => {
    const r = detectInstallTarget({ platform: 'win32' as NodeJS.Platform, env: {} });
    expect(r.target).not.toBe('linux-cron');
  });

  test('darwin -> macos regardless of env', () => {
    const r = detectInstallTarget({ platform: 'darwin' as NodeJS.Platform, env: { RENDER: 'true' } });
    expect(r.target).toBe('macos');
  });

  test('linux + RENDER -> ephemeral-container', () => {
    const r = detectInstallTarget({ platform: 'linux' as NodeJS.Platform, env: { RENDER: 'true' } });
    expect(r.target).toBe('ephemeral-container');
  });

  test('rejects windows-task override on Linux', () => {
    expect(() => detectInstallTarget({ platform: 'linux' as NodeJS.Platform, env: {}, forcedTarget: 'windows-task' }))
      .toThrow(/only valid on win32/);
  });

  test('explicit invalid target throws', () => {
    expect(() => detectInstallTarget({ platform: 'linux' as NodeJS.Platform, env: {}, forcedTarget: 'nope' })).toThrow(/Unknown install target/);
  });

  test('non-windows explicit target that does not match platform still respects override', () => {
    // explicit macos on linux is allowed (for testing/debugging per spec §2.2)
    const r = detectInstallTarget({ platform: 'linux' as NodeJS.Platform, env: {}, forcedTarget: 'macos' });
    expect(r.target).toBe('macos');
  });

  test('ALL_INSTALL_TARGETS includes windows-task', () => {
    expect(ALL_INSTALL_TARGETS).toContain('windows-task');
  });

  test('isInstallTarget validates', () => {
    expect(isInstallTarget('windows-task')).toBe(true);
    expect(isInstallTarget('macos')).toBe(true);
    expect(isInstallTarget('bogus')).toBe(false);
  });
});
