import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { runBrainAdvisor, runWorkspaceAdvisor } from '../src/core/advisor.ts';
import { operationsByName } from '../src/core/operations.ts';

describe('advisor surface split', () => {
  test('MCP advisor is read-only, admin-scoped, and remote-capable', () => {
    const operation = operationsByName.advisor;
    expect(operation).toBeDefined();
    expect(operation.scope).toBe('admin');
    expect(operation.localOnly).toBe(false);
    expect(operation.mutating).not.toBe(true);
  });
  test('brain report contains no workspace diagnostics', async () => {
    const report = await runBrainAdvisor({} as BrainEngine, async () => ({
      schema_version: 2,
      status: 'warnings',
      health_score: 95,
      brain_checks_score: 95,
      category_scores: { brain: 95, skill: 100, ops: 100, meta: 100 },
      checks: [{ name: 'brain_score', status: 'warn', message: 'score below target' }],
    }));
    expect(report.surface).toBe('brain');
    expect(report.findings[0]?.surface).toBe('brain');
    expect(report.diagnostics.workspace).toBeUndefined();
  });

  test('workspace report only emits local CLI next steps', async () => {
    const report = await runWorkspaceAdvisor({
      skillTree: (() => ({ ok: false })) as never,
      skillRouting: (() => ({ ok: true })) as never,
    });
    expect(report.surface).toBe('workspace');
    expect(report.findings.every(finding => finding.next_step.surface === 'local_cli')).toBe(true);
  });
});
