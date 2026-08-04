import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runTrackingMaintenance } from '../src/core/cycle/tracking-maintenance.ts';
import { sweepUnregisteredTrackingEvidence } from '../src/core/cycle/tracking-evidence-sweep.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';
import type { VoltMindConfig } from '../src/core/config.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
const config: VoltMindConfig = { engine: 'pglite' } as VoltMindConfig;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.putPage('sources/teams/unregistered-1', {
    type: 'source_teams',
    title: 'Unregistered Teams evidence',
    compiled_truth: 'A canonical transcript written before registration.',
    timeline: '',
    frontmatter: {
      evidence_type: 'teams_thread',
      tracking_event_id: 'unregistered-event-1',
      tracking_event_version: 'v1',
      tracking_refs: [{ provider: 'teams', resource: 'conversation', id: 'chat-1' }],
    },
  }, { sourceId: 'default' });
});

describe('server evidence sweep', () => {
  test('creates one pending receipt for an evidence page without registration', async () => {
    const first = await sweepUnregisteredTrackingEvidence(engine, { sourceId: 'default', maxPages: 10 });
    expect(first.unregistered).toBe(1);
    expect(first.inserted_receipts).toBe(1);

    const receipt = await engine.executeRaw<Record<string, unknown>>(
      `SELECT outcome, matched_by, evidence_slug, event_key, details
         FROM project_tracking_receipts
        WHERE page_source_id='default' AND target_type='evidence'`,
    );
    expect(receipt).toHaveLength(1);
    expect(receipt[0].outcome).toBe('pending');
    expect(receipt[0].matched_by).toBe('evidence_sweep');
    expect(receipt[0].evidence_slug).toBe('sources/teams/unregistered-1');
    expect(receipt[0].event_key).toBe('unregistered-event-1');
    const details = receipt[0].details as Record<string, unknown>;
    expect(details.audit_reason).toBe('registration_missing');

    const retry = await sweepUnregisteredTrackingEvidence(engine, { sourceId: 'default', maxPages: 10 });
    expect(retry.unregistered).toBe(0);
    expect(retry.already_pending).toBe(1);
    expect(retry.inserted_receipts).toBe(0);
  });

  test('maintenance runs the sweep before queuing repair and carries source scope', async () => {
    const previousRole = process.env.VOLTMIND_RUNTIME_ROLE;
    process.env.VOLTMIND_RUNTIME_ROLE = 'company-server';
    try {
      const submitted: Array<{ name: string; data?: Record<string, unknown> }> = [];
      const result = await runTrackingMaintenance(engine, {
        sourceId: 'default',
        maxEvents: 10,
        queue: {
          add: async (name, data) => {
            submitted.push({ name, data });
            return { id: 101 };
          },
        },
      });
      const sweep = result.details?.evidence_sweep as Record<string, unknown>;
      expect(sweep.inserted_receipts).toBe(1);
      expect(result.details?.repair_jobs).toBe(1);
      expect(submitted).toHaveLength(1);
      expect(submitted[0].name).toBe('subagent');
      const data = submitted[0].data!;
      expect(data.source_id).toBe('default');
      expect(data.tracking_maintenance).toBe(true);
      expect(data.allowed_tools).toContain('register_tracking_evidence');
    } finally {
      if (previousRole === undefined) delete process.env.VOLTMIND_RUNTIME_ROLE;
      else process.env.VOLTMIND_RUNTIME_ROLE = previousRole;
    }
  });

  test('sweep never crosses source boundaries', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('other-source', 'other-source', '{}'::jsonb)`,
    );
    await engine.putPage('sources/teams/unregistered-1', {
      type: 'source_teams',
      title: 'Same slug in another source',
      compiled_truth: 'This belongs to another OAuth source.',
      timeline: '',
      frontmatter: {
        evidence_type: 'teams_thread',
        tracking_event_id: 'other-source-event',
        tracking_event_version: 'v1',
      },
    }, { sourceId: 'other-source' });

    const result = await sweepUnregisteredTrackingEvidence(engine, { sourceId: 'default', maxPages: 10 });
    expect(result.unregistered).toBe(1);
    const otherReceipts = await engine.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM project_tracking_receipts WHERE page_source_id='other-source'`,
    );
    expect(otherReceipts[0].count).toBe(0);
  });

  test('default subagents cannot close tracking receipts; maintenance registry can', () => {
    const normal = buildBrainTools({ subagentId: 1, engine, config });
    const maintenance = buildBrainTools({
      subagentId: 2,
      engine,
      config,
      sourceId: 'default',
      allowTrackingRegistration: true,
    });
    expect(normal.some(tool => tool.name === 'brain_register_tracking_evidence')).toBe(false);
    expect(maintenance.some(tool => tool.name === 'brain_register_tracking_evidence')).toBe(true);
  });

  test('client registration closes a receipt discovered by the sweep', async () => {
    await sweepUnregisteredTrackingEvidence(engine, { sourceId: 'default', maxPages: 10 });
    const page = await engine.getPage('sources/teams/unregistered-1', { sourceId: 'default' });
    const { registerTrackingEvidence } = await import('../src/core/project-tracking-runtime.ts');
    const result = await registerTrackingEvidence(engine, 'default', {
      evidence_slug: 'sources/teams/unregistered-1',
      event_id: 'unregistered-event-1',
      event_version: 'v1',
      evidence_type: 'teams_thread',
      tracking_refs: page?.frontmatter.tracking_refs as Array<{ provider: string; resource: string; id: string }>,
      client_outcome: 'no_signal',
      affected_pages: [],
    });
    expect(result.status).toBe('registered');
    expect(result.recovered).toBe(true);
    const history = await engine.executeRaw<{ outcome: string; matched_by: string }>(
      `SELECT outcome,matched_by FROM project_tracking_receipt_history WHERE target_type='evidence'`,
    );
    expect(history).toEqual([{ outcome: 'registered', matched_by: 'client' }]);
  });
});
