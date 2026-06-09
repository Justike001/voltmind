import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { operations } from '../src/core/operations.ts';
import {
  filterVoltMindMvpOperations,
  isVoltMindMvpCliCommand,
  isVoltMindMvpOperationName,
} from '../src/core/mvp-surface.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, ['run', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, VOLTMIND_HOME: '/tmp/voltmind-test-mvp-surface' },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

describe('VoltMind MVP surface', () => {
  test('CLI allowlist includes core local-first commands and excludes deferred commands', () => {
    for (const name of ['init', 'get', 'put', 'search', 'query', 'import', 'capture', 'sync', 'embed', 'sources', 'serve', 'call', 'jobs']) {
      expect(isVoltMindMvpCliCommand(name)).toBe(true);
    }
    for (const name of ['agent', 'autopilot', 'dream', 'eval', 'skillpack', 'think', 'recall', 'forget', 'schema', 'founder', 'transcripts', 'code-def']) {
      expect(isVoltMindMvpCliCommand(name)).toBe(false);
    }
  });

  test('MCP tool discovery only exposes MVP operations', () => {
    const defs = buildToolDefs(filterVoltMindMvpOperations(operations));
    const names = defs.map(d => d.name);
    expect(names).toContain('get_page');
    expect(names).toContain('put_page');
    expect(names).toContain('search');
    expect(names).toContain('query');
    expect(names).toContain('sources_list');
    expect(names).toContain('list_jobs');
    expect(names).toContain('put_raw_data');
    expect(names).toContain('get_raw_data');
    expect(names).not.toContain('submit_job');
    expect(names).not.toContain('think');
    expect(names).not.toContain('recall');
    expect(names).not.toContain('search_by_image');
    expect(names).not.toContain('run_onboard');
    expect(names.every(isVoltMindMvpOperationName)).toBe(true);
    expect(defs.find(d => d.name === 'query')?.description).not.toContain('get_recent_salience');
    expect(defs.find(d => d.name === 'search')?.description).not.toContain('code_callers');
  });

  test('MCP dispatch refuses hidden inherited operations even if called directly', async () => {
    const result = await dispatchToolCall({} as never, 'think', {}, { remote: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not_in_mvp');
  });

  test('--tools-json uses the MVP operation subset', () => {
    const { stdout, status } = runCli(['--tools-json']);
    expect(status).toBe(0);
    const tools = JSON.parse(stdout) as Array<{ name: string }>;
    const names = tools.map(t => t.name);
    expect(names).toContain('get_page');
    expect(names).toContain('query');
    expect(names).toContain('put_raw_data');
    expect(names).toContain('get_raw_data');
    expect(names).not.toContain('think');
    expect(names).not.toContain('run_onboard');
  }, 15_000);
});
