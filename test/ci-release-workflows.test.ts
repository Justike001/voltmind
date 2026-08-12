import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';

type Workflow = {
  name?: string;
  jobs?: Record<string, {
    name?: string;
    needs?: string | string[];
    steps?: Array<{ run?: string; uses?: string; with?: Record<string, unknown> }>;
  }>;
};

function workflow(name: string): Workflow {
  return load(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')) as Workflow;
}

function rendered(value: unknown): string {
  return JSON.stringify(value);
}

describe('VoltMind CI and release contracts', () => {
  test('one Test workflow gates every required surface on the same commit', () => {
    const ci = workflow('test.yml');
    const jobs = ci.jobs ?? {};

    expect(ci.name).toBe('Test');
    expect(Object.keys(jobs)).toEqual(expect.arrayContaining([
      'test',
      'serial',
      'heavy',
      'windows-adapter',
      'tier1-thin-client',
      'tier2-host-mcp',
      'test-status',
    ]));
    expect(jobs['test-status']?.needs).toEqual(expect.arrayContaining([
      'test',
      'serial',
      'heavy',
      'windows-adapter',
      'tier1-thin-client',
      'tier2-host-mcp',
    ]));

    const text = rendered(ci);
    expect(text).toContain('test:e2e:tier1');
    expect(text).toContain('test:e2e:tier2');
    expect(text).toContain('test:heavy:host');
    expect(text).toContain('VOLTMIND_REMOTE_MCP_URL');
    expect(text).toContain('VOLTMIND_REMOTE_ISSUER_URL');
    expect(text).toContain('VOLTMIND_REMOTE_CLIENT_ID');
    expect(text).toContain('VOLTMIND_REMOTE_CLIENT_SECRET');
    expect(text).not.toContain('TS_AUTHKEY');
    expect(text).not.toContain('DATABASE_URL');
    expect(text).not.toContain('pgvector/pgvector');
    expect(text).not.toContain('services');
    expect(text).not.toContain('OPENAI_API_KEY');
    expect(text).not.toContain('ANTHROPIC_API_KEY');
    expect(text).not.toContain('openclaw@');
    expect(text).not.toContain('ci-pass-');

    const hostProbe = readFileSync(new URL('../scripts/host-mcp-e2e.ts', import.meta.url), 'utf8');
    expect(hostProbe).toContain("'get_brain_identity'");
    expect(hostProbe).toContain("'schema_stats'");
    expect(hostProbe).toContain("'recall'");
    expect(hostProbe).not.toContain("'get_status_snapshot'");
    expect(hostProbe).not.toContain("'list_jobs'");
    expect(hostProbe).not.toContain("'run_doctor'");
  });

  test('release requires the green SHA, checksums every binary, and attests provenance', () => {
    const release = workflow('release.yml');
    const text = rendered(release);

    expect(text).toContain('head_sha=$GITHUB_SHA');
    expect(text).toContain('git merge-base --is-ancestor');
    expect(text).toContain('SHA256SUMS');
    expect(text).toContain('actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6');
    expect(text).toContain('softprops/action-gh-release@3d0d9888cb7fd7b750713d6e236d1fcb99157228');
    expect(text).toContain('voltmind-windows-x64.exe');
  });
});
