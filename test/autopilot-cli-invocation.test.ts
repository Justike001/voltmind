/**
 * Unit tests for resolveCliInvocation() (spec §4 / §16.1).
 *
 * Iron rules (regression for the original Bug 4):
 *   - `.ts` files are NEVER returned as an executable. Source entries are
 *     converted to `bun <entry.ts> <args>`.
 *   - `.cmd` shims are invoked via ComSpec `/d /s /c "..."`.
 *   - Windows discovery uses `where.exe`; Unix uses `which`.
 *   - Task action and worker spawn share the same resolver.
 */

import { describe, test, expect } from 'bun:test';
import { resolveCliInvocation, buildCliArgv, formatCliForDisplay } from '../src/core/autopilot/cli-invocation.ts';
import { buildSpawnInvocation, buildSpawnInvocationFromCli } from '../src/core/minions/spawn-helpers.ts';

describe('resolveCliInvocation', () => {
  test('never returns a .ts path as the executable', async () => {
    const origArg1 = process.argv[1];
    process.argv[1] = '/some/project/src/cli.ts';
    try {
      const inv = await resolveCliInvocation({ preferBunSource: false });
      expect(inv.executable.endsWith('.ts')).toBe(false);
      expect(inv.executable.endsWith('.tsx')).toBe(false);
    } finally {
      process.argv[1] = origArg1;
    }
  });

  test('classifies a .cmd shim as windows-cmd-shim with ComSpec framing', async () => {
    // Create a real temp .cmd file so the explicit-path branch runs the
    // classifier instead of throwing on a missing file.
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voltmind-cli-'));
    const cmdPath = path.join(tmp, 'voltmind.cmd');
    fs.writeFileSync(cmdPath, '@echo off');
    try {
      const inv = await resolveCliInvocation({ explicitPath: cmdPath, repoRoot: tmp });
      expect(inv.source).toBe('windows-cmd-shim');
      expect(inv.prefixArgs[0]).toBe('/d');
      expect(inv.prefixArgs[1]).toBe('/s');
      expect(inv.prefixArgs[2]).toBe('/c');
      // The cmd path appears quoted as the 4th prefix arg element.
      expect(inv.prefixArgs[3]).toContain('voltmind.cmd');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('source is one of the allowed enum values', async () => {
    const inv = await resolveCliInvocation().catch(() => null);
    if (inv) {
      expect(['native-exe', 'windows-cmd-shim', 'bun-source', 'unix-binary', 'unix-shim']).toContain(inv.source);
    }
  });

  test('buildCliArgv appends subcommand args after prefix args', () => {
    const argv = buildCliArgv(
      { executable: '/bin/voltmind', prefixArgs: [], source: 'unix-binary' },
      ['jobs', 'work', '--max-rss', '2048'],
    );
    expect(argv).toEqual(['jobs', 'work', '--max-rss', '2048']);
  });

  test('buildCliArgv preserves .cmd ComSpec framing before subcommand args', () => {
    const argv = buildCliArgv(
      { executable: 'cmd.exe', prefixArgs: ['/d', '/s', '/c', '"C:\\voltmind.cmd"'], source: 'windows-cmd-shim' },
      ['autopilot', '--repo', 'C:\\repo'],
    );
    expect(argv.slice(0, 4)).toEqual(['/d', '/s', '/c', '"C:\\voltmind.cmd"']);
    expect(argv.slice(4)).toEqual(['autopilot', '--repo', 'C:\\repo']);
  });

  test('formatCliForDisplay quotes args with spaces', () => {
    const s = formatCliForDisplay(
      { executable: '/bin/voltmind', prefixArgs: [], source: 'unix-binary' },
      ['autopilot', '--repo', '/path with space/repo'],
    );
    expect(s).toContain('"/path with space/repo"');
  });
});

describe('buildSpawnInvocationFromCli — supervisor + scheduler share resolver', () => {
  test('direct binary: cmd=executable, args=subcommand args', () => {
    const inv = { executable: '/bin/voltmind', prefixArgs: [], source: 'unix-binary' as const };
    const result = buildSpawnInvocationFromCli('', inv, ['jobs', 'work']);
    expect(result).toEqual({ cmd: '/bin/voltmind', args: ['jobs', 'work'] });
  });

  test('with tini: wraps executable + args', () => {
    const inv = { executable: '/bin/voltmind', prefixArgs: [], source: 'unix-binary' as const };
    const result = buildSpawnInvocationFromCli('/usr/bin/tini', inv, ['jobs', 'work']);
    expect(result).toEqual({ cmd: '/usr/bin/tini', args: ['--', '/bin/voltmind', 'jobs', 'work'] });
  });

  test('.cmd shim: passed through unchanged (no tini wrap)', () => {
    const inv = { executable: 'cmd.exe', prefixArgs: ['/d', '/s', '/c', '"C:\\v.cmd"'], source: 'windows-cmd-shim' as const };
    const result = buildSpawnInvocationFromCli('/usr/bin/tini', inv, ['jobs', 'work']);
    expect(result.cmd).toBe('cmd.exe');
    expect(result.args).toEqual(['/d', '/s', '/c', '"C:\\v.cmd"', 'jobs', 'work']);
  });

  test('legacy buildSpawnInvocation still works (backward compat)', () => {
    const result = buildSpawnInvocation('/usr/bin/tini', '/bin/voltmind', ['jobs', 'work']);
    expect(result).toEqual({ cmd: '/usr/bin/tini', args: ['--', '/bin/voltmind', 'jobs', 'work'] });
  });
});
