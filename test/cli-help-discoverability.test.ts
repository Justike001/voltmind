/**
 * v0.39.3.0 WARN-5 + WARN-6 — CLI help discoverability.
 *
 * WARN-5: `voltmind capture --help` was showing only the generic
 * `Usage: voltmind capture` line because `capture` was missing from
 * CLI_ONLY_SELF_HELP (src/cli.ts:34-53). Fix added it to the set AND
 * added a pre-engine-bind `--help` short-circuit at handleCliOnly so
 * the HELP constant is reachable on a fresh tmpdir with no config.
 *
 * WARN-6: `capture`, `brainstorm`, `lsd` were missing from the main
 * `voltmind --help` text. Added a BRAIN section to printHelp.
 *
 * These tests spawn `bun run src/cli.ts` as a subprocess so they
 * exercise the real dispatcher flow end-to-end (no mocking of
 * cli.ts internals).
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, ['run', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, VOLTMIND_HOME: '/tmp/voltmind-test-help-nonexistent' },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

describe('WARN-5 — `voltmind capture --help` reaches the detailed HELP constant', () => {
  test('output contains every documented flag', () => {
    const { stdout, status } = runCli(['capture', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('--slug');
    expect(stdout).toContain('--type');
    expect(stdout).toContain('--file');
    expect(stdout).toContain('--stdin');
    expect(stdout).toContain('--source');
    expect(stdout).toContain('--quiet');
    expect(stdout).toContain('--json');
  });

  test('output is NOT the generic short-circuit fallback', () => {
    const { stdout } = runCli(['capture', '--help']);
    // Pre-fix output was: "Usage: voltmind capture\n\ngbrain capture - run voltmind --help ..."
    // Post-fix HELP is much longer and includes Examples.
    expect(stdout).toContain('Examples:');
    expect(stdout.split('\n').length).toBeGreaterThan(10);
    expect(stdout).not.toMatch(/^Usage: voltmind capture\s*$/m);
  });

  test('-h short flag also works', () => {
    const { stdout, status } = runCli(['capture', '-h']);
    expect(status).toBe(0);
    expect(stdout).toContain('--file PATH');
  });
});

describe('VoltMind MVP main `voltmind --help` surface', () => {
  test('output mentions core MVP commands by name', () => {
    const { stdout, status } = runCli(['--help']);
    expect(status).toBe(0);
    // Must appear as command names (not just words in prose somewhere)
    expect(stdout).toMatch(/^\s*capture\s/m);
    expect(stdout).toMatch(/^\s*sources\s/m);
    expect(stdout).toMatch(/^\s*jobs list\s/m);
    expect(stdout).toMatch(/^\s*salience\s/m);
    expect(stdout).toMatch(/^\s*anomalies\s/m);
    expect(stdout).toMatch(/^\s*whoknows\s/m);
    expect(stdout).toMatch(/^\s*calibration\s/m);
    expect(stdout).toMatch(/^\s*extract\s/m);
    expect(stdout).toMatch(/^\s*extract-conversation-facts\s/m);
    expect(stdout).toMatch(/^\s*files mirror\s/m);
    expect(stdout).toMatch(/^\s*transcripts recent\s/m);
    expect(stdout).toMatch(/^\s*takes\s/m);
    expect(stdout).toMatch(/^\s*recall\s/m);
    expect(stdout).toMatch(/^\s*forget preview\s/m);
   expect(stdout).toMatch(/^\s*candidates\s/m);
   expect(stdout).toMatch(/^\s*conversation-parser scan\s/m);
 expect(stdout).toMatch(/^\s*graph-query\s/m);
  });

  test('advanced inherited commands are hidden from MVP help', () => {
    const { stdout } = runCli(['--help']);
    expect(stdout).not.toMatch(/^\s*brainstorm\s/m);
    expect(stdout).not.toMatch(/^\s*lsd\s/m);
    expect(stdout).not.toMatch(/^\s*autopilot\s/m);
    expect(stdout).not.toMatch(/^\s*think\s/m);
    expect(stdout).not.toMatch(/^\s*schema\s/m);
    expect(stdout).not.toMatch(/^\s*code-def\s/m);
    expect(stdout).not.toMatch(/^\s*founder\s/m);
    expect(stdout).not.toMatch(/^\s*takes add\s/m);
    expect(stdout).not.toMatch(/^\s*takes supersede\s/m);
  });

  test('regression: existing top-level commands still listed', () => {
    // Snapshot guard against accidentally deleting other groups when we
    // added the BRAIN section. Spot-check a few commands from different
    // groups (SETUP, PAGES, SEARCH, IMPORT/EXPORT).
    const { stdout } = runCli(['--help']);
    expect(stdout).toContain('init');
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('get');
    expect(stdout).toContain('search');
    expect(stdout).toContain('query');
    expect(stdout).toContain('import');
    expect(stdout).toContain('files mirror');
    expect(stdout).toContain('capture');
    expect(stdout).toContain('sync');
    expect(stdout).toContain('embed');
    expect(stdout).toContain('extract');
    expect(stdout).toContain('extract-conversation-facts');
    expect(stdout).toContain('transcripts');
    expect(stdout).toContain('takes');
    expect(stdout).toContain('conversation-parser');
    expect(stdout).toContain('recall');
    expect(stdout).toContain('candidates');
  });

  test('files help reaches migration subcommands without a configured brain', () => {
    const { stdout, status } = runCli(['files', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('mirror <dir>');
    expect(stdout).toContain('redirect <dir>');
    expect(stdout).toContain('clean <dir>');
    expect(stdout).toContain('upload-raw <file>');
    expect(stdout).not.toContain('No brain configured');
  });

  test('advanced inherited commands return a clear MVP message', () => {
    const { stderr, status } = runCli(['think', '--help']);
    expect(status).toBe(1);
    expect(stderr).toContain('not included in the VoltMind MVP runtime yet');
  });

  test('jobs help exposes only MVP job subcommands', () => {
    const { stdout, status } = runCli(['jobs', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('jobs list');
    expect(stdout).toContain('jobs get');
    expect(stdout).toContain('jobs cancel');
    expect(stdout).toContain('jobs progress');
    expect(stdout).toContain('jobs failures');
    expect(stdout).toContain('jobs checkpoints');
    expect(stdout).toContain('jobs undo-report');
    expect(stdout).toContain('jobs plan');
    expect(stdout).toContain('jobs stats');
    expect(stdout).not.toContain('jobs submit');
    expect(stdout).not.toContain('jobs work');
    expect(stdout).not.toContain('jobs supervisor');
  });

  test('insight command help reaches detailed help without a configured brain', () => {
    for (const [command, expected] of [
      ['salience', 'Pages recently touched'],
      ['anomalies', 'Statistical anomalies'],
      ['whoknows', 'Ask your brain who knows'],
      ['calibration', 'Read and manage the active calibration profile'],
    ]) {
      const { stdout, status } = runCli([command, '--help']);
      expect(status).toBe(0);
      expect(stdout).toContain(expected);
      expect(stdout).not.toMatch(new RegExp(`^Usage: voltmind ${command}\\s*$`, 'm'));
    }
  });

  test('retrieval enrichment command help reaches detailed help without a configured brain', () => {
    for (const [args, expected] of [
      [['extract', '--help'], 'Extract deterministic retrieval signals'],
      [['extract-conversation-facts', '--help'], 'Batch-extract facts from conversation pages'],
      [['extract-conversation-facts', '--help'], '--propose'],
      [['transcripts', '--help'], 'Recent raw conversation transcripts'],
    ] as const) {
      const { stdout, status } = runCli([...args]);
      expect(status).toBe(0);
      expect(stdout).toContain(expected);
    }
  });

  test('judgment readout command help reaches detailed help without a configured brain', () => {
    for (const [args, expected] of [
      [['takes', '--help'], 'Mutating and aggregate judgment subcommands'],
      [['recall', '--help'], 'one-shot memory recall'],
      [['forget', '--help'], 'controlled fact forget'],
      [['candidates', '--help'], 'review proposed enrichment'],
      [['conversation-parser', '--help'], 'Dry-run the parser on a page'],
    ] as const) {
      const { stdout, status } = runCli([...args]);
      expect(status).toBe(0);
      expect(stdout).toContain(expected);
    }
  });

  test('takes mutating subcommands stay outside the MVP public surface', () => {
    for (const sub of ['add', 'update', 'supersede', 'resolve', 'scorecard', 'calibration', 'revisit', 'extract']) {
      const { stderr, status } = runCli(['takes', sub, '--help']);
      expect(status).toBe(1);
      expect(stderr).toContain('takes readouts only');
    }
  }, 20000);
});
