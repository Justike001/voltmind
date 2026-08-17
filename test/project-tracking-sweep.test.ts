import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runTrackingMaintenance } from '../src/core/cycle/tracking-maintenance.ts';
import { sweepUnregisteredTrackingEvidence } from '../src/core/cycle/tracking-evidence-sweep.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';
import { computeContentHash } from '../src/core/ingestion/types.ts';
import type { VoltMindConfig } from '../src/core/config.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

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
    await withEnv({ VOLTMIND_RUNTIME_ROLE: 'company-server' }, async () => {
      const submitted: Array<{ name: string; data?: Record<string, unknown>; opts?: Record<string, unknown> }> = [];
      const result = await runTrackingMaintenance(engine, {
        sourceId: 'default',
        maxEvents: 10,
        queue: {
          add: async (name, data, opts) => {
            submitted.push({ name, data, opts });
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
      // Regression (A5): the repair prompt must pass the CANONICAL event_key as the
      // event identity — not event_source_id/event_kind/event_key concatenated (the
      // key is already source-qualified, so concatenating over-qualifies it). The
      // over-qualified form made agents register under a shadow identity, leaving
      // the real receipt stuck in 'repairing' forever.
      expect(String(data.prompt)).toContain('Event identity: unregistered-event-1');
      expect(String(data.prompt)).not.toContain('default/teams_thread/unregistered-event-1');
      expect(String(data.prompt)).toContain('Evidence type: teams_thread');
      // Regression: an 8-turn repair job must not fall into the worker's 180s
      // wall-clock default. The submit must carry a real timeout_ms so the hard
      // deadline is timeout_ms and wall-clock headroom is 2*timeout_ms.
      const timeoutMs = submitted[0].opts?.timeout_ms as number | undefined;
      expect(typeof timeoutMs).toBe('number');
      expect(timeoutMs!).toBeGreaterThan(5 * 60 * 1000);
    });
  });

  test('maintenance prioritizes actionable receipts over closed ones inside the scan budget', async () => {
    await withEnv({ VOLTMIND_RUNTIME_ROLE: 'company-server' }, async () => {
      const page = await engine.getPage('sources/teams/unregistered-1', { sourceId: 'default' });
      const hash = page?.content_hash ?? computeContentHash('x');
      // 10 closed receipts whose event_keys sort BEFORE the actionable one. In the
      // old ordering (by event_key, LIMIT 10) these fill the whole scan budget and
      // the actionable receipt is starved forever.
      for (let i = 0; i < 10; i++) {
        await engine.executeRaw(
          `INSERT INTO project_tracking_receipts
             (page_source_id,event_source_id,event_kind,event_key,target_type,target_slug,event_version,content_hash,render_hash,evidence_slug,outcome,matched_by,details,updated_at)
           VALUES ('default','default','teams_thread','a-closed-${i}','evidence','sources/teams/unregistered-1','v1',$1,$1,'sources/teams/unregistered-1','verified','client','{}'::jsonb,now())`,
          [hash],
        );
      }
      // One actionable pending receipt whose key sorts AFTER the closed ones.
      await engine.executeRaw(
        `INSERT INTO project_tracking_receipts
           (page_source_id,event_source_id,event_kind,event_key,target_type,target_slug,event_version,content_hash,render_hash,evidence_slug,outcome,matched_by,details,updated_at)
         VALUES ('default','default','teams_thread','z-pending-1','evidence','sources/teams/unregistered-1','v1',$1,$1,'sources/teams/unregistered-1','pending','evidence_sweep','{}'::jsonb,now())`,
        [hash],
      );
      const submitted: Array<{ name: string; data?: Record<string, unknown> }> = [];
      await runTrackingMaintenance(engine, {
        sourceId: 'default',
        maxEvents: 10,
        queue: {
          add: async (name, data) => { submitted.push({ name, data }); return { id: 1 }; },
        },
      });
      // The actionable receipt must be inside the 10-row scan budget despite
      // sorting last alphabetically.
      expect(submitted.some(s => String(s.data?.prompt).includes('z-pending-1'))).toBe(true);
      expect(submitted.filter(s => s.name === 'subagent').length).toBeGreaterThanOrEqual(1);
    });
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
