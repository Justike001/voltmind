import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeProjectTrackProgressHandler } from '../src/core/minions/handlers/project-track-progress.ts';
import { registerTrackingEvidence } from '../src/core/project-tracking-runtime.ts';
import { computeContentHash, type IngestionEvent } from '../src/core/ingestion/types.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.putPage('projects/connector-rollout', {
    type: 'project',
    title: 'Connector rollout',
    compiled_truth: 'User-authored project context.',
    timeline: '',
    frontmatter: {
      status: 'active',
      tracking_bindings: [
        { provider: 'teams', resource: 'conversation', id: 'chat-1' },
      ],
    },
  }, { sourceId: 'default' });
  await engine.putPage('sources/teams/chat-1', {
    type: 'source_teams',
    title: 'Teams chat 1',
    compiled_truth: 'Canonical transcript.',
    timeline: '',
    frontmatter: { evidence_type: 'teams_thread' },
  }, { sourceId: 'default' });
});

function event(content: string, version = '2026-07-31T10:00:00Z'): IngestionEvent {
  return {
    source_id: 'default',
    source_kind: 'microsoft-connector-relay',
    source_uri: 'https://teams.example/chat-1',
    received_at: version,
    content_type: 'text/markdown',
    content,
    content_hash: computeContentHash(content),
    event_id: 'message-1',
    event_version: version,
    tracking_refs: [{ provider: 'teams', resource: 'conversation', id: 'chat-1' }],
    evidence_type: 'teams_thread',
    untrusted_payload: true,
  };
}

function job(value: IngestionEvent, pageSourceId = 'default'): MinionJobContext {
  return {
    id: 1,
    name: 'project_track_progress',
    data: {
      event: value,
      evidence_slug: 'sources/teams/chat-1',
      page_source_id: pageSourceId,
    },
    attempts_made: 1,
    signal: new AbortController().signal,
    shutdownSignal: new AbortController().signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  };
}

describe('project_track_progress compatibility handler', () => {
  test('acknowledges legacy jobs without mutating project or state pages', async () => {
    const handler = makeProjectTrackProgressHandler(engine);
    const input = event(`
# Update
## Action Items
- Ship connector | Owner: Alice | Due: 2026-08-05
## Decisions
- Keep automatic tracking on the server
`);
    const result = await handler(job(input));

    const project = await engine.getPage('projects/connector-rollout', { sourceId: 'default' });
    expect(project?.compiled_truth).toContain('User-authored project context.');
    const actions = await engine.listPages({
      sourceId: 'default',
      slugPrefix: 'state/actions/',
      sort: 'slug',
    });
    expect(actions).toHaveLength(0);
    expect(result.outcome).toBe('deprecated');

    const receipts = await engine.executeRaw<{ count: string }>(
      'SELECT count(*)::text AS count FROM project_tracking_receipt_history',
    );
    expect(receipts[0]?.count).toBe('1');
  });

  test('legacy jobs without a canonical evidence page remain review-needed', async () => {
    const handler = makeProjectTrackProgressHandler(engine);
    const first = event('- action: Ship connector');
    const result = await handler(job(first));
    expect(result.outcome).toBe('deprecated');
    expect(result.review_needed).toBe(true);
  });

  test('does not throw for an old job with a missing page source', async () => {
    const handler = makeProjectTrackProgressHandler(engine);
    const missing = job(event('- action: Do not write'), 'missing-source');
    const result = await handler(missing);
    expect(result.review_needed).toBe(true);
    missing.data = { ...(missing.data as Record<string, unknown>), page_source_id: undefined };
    expect((await handler(missing)).review_needed).toBe(true);
  });
});

describe('register_tracking_evidence', () => {
  test('records an idempotent client revision without changing target pages', async () => {
    const result = await registerTrackingEvidence(engine, 'default', {
      evidence_slug: 'sources/teams/chat-1',
      event_id: 'message-1',
      event_version: '1',
      evidence_type: 'teams_thread',
      tracking_refs: [{ provider: 'teams', resource: 'conversation', id: 'chat-1' }],
      client_outcome: 'applied',
      affected_pages: ['projects/connector-rollout'],
    });
    expect(result.status).toBe('registered');
    const duplicate = await registerTrackingEvidence(engine, 'default', {
      evidence_slug: 'sources/teams/chat-1',
      event_id: 'message-1',
      event_version: '1',
      evidence_type: 'teams_thread',
      client_outcome: 'applied',
      affected_pages: ['projects/connector-rollout'],
    });
    expect(duplicate.status).toBe('duplicate');
    const receipt = await engine.executeRaw<{ target_type: string; outcome: string }>(
      `SELECT target_type, outcome FROM project_tracking_receipts WHERE target_type='evidence'`,
    );
    expect(receipt).toEqual([{ target_type: 'evidence', outcome: 'registered' }]);
  });

  test('downgrades an incomplete action projection to semantic review_required', async () => {
    const actionSlug = 'state/actions/collect-samples';
    await engine.putPage(actionSlug, {
      type: 'action',
      title: 'Collect samples',
      compiled_truth: 'Two participants should collect samples.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' });
    await engine.putPage('people/alice-example', {
      type: 'person', title: 'Alice Example', compiled_truth: 'No backlink yet.', timeline: '', frontmatter: {},
    }, { sourceId: 'default' });

    const result = await registerTrackingEvidence(engine, 'default', {
      evidence_slug: 'sources/teams/chat-1',
      event_id: 'message-action-1',
      event_version: '1',
      evidence_type: 'teams_thread',
      client_outcome: 'created',
      affected_pages: [actionSlug],
      action_assignments: [{
        action_slug: actionSlug,
        assignees: [{ slug: 'people/alice-example', display_name: 'Alice Example', source_text: 'Alice Example' }],
      }],
    });

    expect(result.status).toBe('review_needed');
    expect(result.semantic_status).toBe('review_required');
    const rows = await engine.executeRaw<{ outcome: string; details: Record<string, unknown> }>(
      `SELECT outcome, details FROM project_tracking_receipts WHERE event_key='message-action-1'`,
    );
    expect(rows[0]?.outcome).toBe('review_needed');
    expect(rows[0]?.details.semantic_status).toBe('review_required');
    expect(rows[0]?.details.client_outcome).toBe('review_needed');
    expect(rows[0]?.details.action_assignments).toEqual(expect.any(Array));
  });

  test('recovers review_required only after every assignee surface is complete', async () => {
    const actionSlug = 'state/actions/collect-samples';
    const assignment = {
      action_slug: actionSlug,
      assignees: [{ slug: 'people/alice-example', display_name: 'Alice Example', source_text: 'Alice Example' }],
    };
    await engine.putPage(actionSlug, {
      type: 'action', title: 'Collect samples', compiled_truth: 'Anonymous participant.', timeline: '', frontmatter: {},
    }, { sourceId: 'default' });
    await engine.putPage('people/alice-example', {
      type: 'person', title: 'Alice Example', compiled_truth: 'No backlink yet.', timeline: '', frontmatter: {},
    }, { sourceId: 'default' });
    const input = {
      evidence_slug: 'sources/teams/chat-1',
      event_id: 'message-action-2',
      event_version: '1',
      evidence_type: 'teams_thread' as const,
      client_outcome: 'created' as const,
      affected_pages: [actionSlug],
      action_assignments: [assignment],
    };
    expect((await registerTrackingEvidence(engine, 'default', input)).semantic_status).toBe('review_required');

    await engine.putPage(actionSlug, {
      type: 'action',
      title: 'Collect samples',
      compiled_truth: 'Assigned to [[people/alice-example|Alice Example]].',
      timeline: '',
      frontmatter: { related_people: ['people/alice-example'] },
    }, { sourceId: 'default' });
    await engine.putPage('people/alice-example', {
      type: 'person',
      title: 'Alice Example',
      compiled_truth: `Current action: [[${actionSlug}]].`,
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' });

    const recovered = await registerTrackingEvidence(engine, 'default', input);
    expect(recovered.status).toBe('registered');
    expect(recovered.semantic_status).toBe('complete');
    expect(recovered.recovered).toBe(true);
  });
});
