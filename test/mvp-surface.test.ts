import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { operations } from '../src/core/operations.ts';
import {
  filterVoltMindMvpOperations,
  isVoltMindMvpCliCommand,
  isVoltMindMvpOperationName,
} from '../src/core/mvp-surface.ts';
import { LOCAL_DAEMON_COMMANDS } from '../src/core/local-daemon.ts';
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
  for (const name of ['init', 'get', 'put', 'search', 'query', 'import', 'files', 'capture', 'sync', 'embed', 'extract', 'extract-conversation-facts', 'enrich', 'transcripts', 'sources', 'serve', 'call', 'jobs', 'salience', 'anomalies', 'whoknows', 'calibration', 'takes', 'conversation-parser', 'recall', 'forget', 'candidates', 'graph-query']) {
     expect(isVoltMindMvpCliCommand(name)).toBe(true);
    }
    for (const name of ['agent', 'autopilot', 'dream', 'eval', 'skillpack', 'think', 'schema', 'founder', 'code-def', 'submit_job']) {
      expect(isVoltMindMvpCliCommand(name)).toBe(false);
    }
  });

  test('daemon forwarding includes DB-writing enrich CLI path', () => {
    expect(LOCAL_DAEMON_COMMANDS.has('enrich')).toBe(true);
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
    expect(names).toContain('preview_signal_enrichment');
    expect(names).toContain('apply_signal_enrichment');
    expect(names).toContain('get_job_progress');
    expect(names).toContain('get_job_failure_report');
    expect(names).toContain('get_job_checkpoints');
    expect(names).toContain('get_job_undo_report');
    expect(names).toContain('plan_job_batch');
    expect(names).toContain('get_recent_salience');
    expect(names).toContain('find_anomalies');
    expect(names).toContain('find_experts');
    expect(names).toContain('get_calibration_profile');
    expect(names).toContain('get_recent_transcripts');
    expect(names).toContain('find_contradictions');
    expect(names).toContain('find_trajectory');
    expect(names).toContain('takes_list');
    expect(names).toContain('takes_search');
    expect(names).toContain('recall');
    expect(names).toContain('preview_forget_fact');
    expect(names).toContain('apply_forget_fact');
    expect(names).toContain('propose_extraction_candidates');
    expect(names).toContain('preview_candidate_apply');
    expect(names).toContain('apply_candidate');
    expect(names).toContain('reject_candidate');
    expect(names).not.toContain('submit_job');
    expect(names).not.toContain('retry_job');
    expect(names).not.toContain('replay_job');
    expect(names).not.toContain('pause_job');
    expect(names).not.toContain('resume_job');
    expect(names).not.toContain('think');
    expect(names).not.toContain('extract_facts');
    expect(names).not.toContain('forget_fact');
    expect(names).not.toContain('file_list');
    expect(names).not.toContain('file_upload');
    expect(names).not.toContain('file_url');
    expect(names).not.toContain('takes_scorecard');
    expect(names).not.toContain('takes_calibration');
    expect(names).not.toContain('search_by_image');
    expect(names).not.toContain('run_onboard');
    expect(names.every(isVoltMindMvpOperationName)).toBe(true);
    expect(defs.find(d => d.name === 'query')?.description).not.toContain('get_recent_salience');
    expect(defs.find(d => d.name === 'search')?.description).not.toContain('code_callers');
    expect(Object.keys(defs.find(d => d.name === 'get_recent_salience')?.inputSchema.properties ?? {})).toEqual(['days', 'limit', 'slugPrefix']);
    expect(Object.keys(defs.find(d => d.name === 'find_anomalies')?.inputSchema.properties ?? {})).toEqual(['since', 'lookback_days', 'sigma']);
    expect(Object.keys(defs.find(d => d.name === 'find_experts')?.inputSchema.properties ?? {})).toEqual(['topic', 'limit', 'explain']);
    expect(Object.keys(defs.find(d => d.name === 'get_calibration_profile')?.inputSchema.properties ?? {})).toEqual(['holder']);
    expect(Object.keys(defs.find(d => d.name === 'get_recent_transcripts')?.inputSchema.properties ?? {})).toEqual(['days', 'summary', 'limit']);
    expect(Object.keys(defs.find(d => d.name === 'find_contradictions')?.inputSchema.properties ?? {})).toEqual(['slug', 'severity', 'limit']);
    expect(Object.keys(defs.find(d => d.name === 'find_trajectory')?.inputSchema.properties ?? {})).toEqual(['entity_slug', 'metric', 'kind', 'since', 'until', 'limit']);
    expect(Object.keys(defs.find(d => d.name === 'takes_list')?.inputSchema.properties ?? {})).toEqual(['page_slug', 'holder', 'kind', 'active', 'resolved', 'sort_by', 'limit', 'offset']);
    expect(Object.keys(defs.find(d => d.name === 'takes_search')?.inputSchema.properties ?? {})).toEqual(['query', 'limit']);
    expect(Object.keys(defs.find(d => d.name === 'recall')?.inputSchema.properties ?? {})).toEqual(['entity', 'since', 'session_id', 'grep', 'limit', 'include_pending', 'include_expired', 'supersessions']);
    expect(Object.keys(defs.find(d => d.name === 'apply_forget_fact')?.inputSchema.properties ?? {})).toEqual(['id', 'reason', 'source_id', 'citation', 'confirm']);
    expect(Object.keys(defs.find(d => d.name === 'preview_signal_enrichment')?.inputSchema.properties ?? {})).toEqual(['source_id', 'page_slug', 'text', 'limit', 'external']);
    expect(Object.keys(defs.find(d => d.name === 'apply_signal_enrichment')?.inputSchema.properties ?? {})).toEqual(['source_id', 'page_slug', 'text', 'limit', 'external', 'confirm']);
    expect(Object.keys(defs.find(d => d.name === 'apply_candidate')?.inputSchema.properties ?? {})).toEqual(['candidate_id', 'source_id', 'citation', 'confirm']);
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
    expect(names).toContain('preview_signal_enrichment');
    expect(names).toContain('apply_signal_enrichment');
    expect(names).toContain('get_recent_salience');
    expect(names).toContain('find_anomalies');
    expect(names).toContain('find_experts');
    expect(names).toContain('get_calibration_profile');
    expect(names).toContain('get_recent_transcripts');
    expect(names).toContain('find_contradictions');
    expect(names).toContain('find_trajectory');
    expect(names).toContain('takes_list');
    expect(names).toContain('takes_search');
    expect(names).toContain('recall');
    expect(names).toContain('preview_forget_fact');
    expect(names).toContain('apply_forget_fact');
    expect(names).toContain('propose_extraction_candidates');
    expect(names).toContain('preview_candidate_apply');
    expect(names).toContain('apply_candidate');
    expect(names).toContain('reject_candidate');
    expect(names).not.toContain('think');
    expect(names).not.toContain('extract_facts');
    expect(names).not.toContain('forget_fact');
    expect(names).not.toContain('file_list');
    expect(names).not.toContain('file_upload');
    expect(names).not.toContain('file_url');
    expect(names).not.toContain('takes_scorecard');
    expect(names).not.toContain('takes_calibration');
    expect(names).not.toContain('run_onboard');
  }, 15_000);
});

