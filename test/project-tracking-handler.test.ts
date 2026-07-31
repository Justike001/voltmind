import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeProjectTrackProgressHandler } from '../src/core/minions/handlers/project-track-progress.ts';
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

describe('project_track_progress handler', () => {
  test('updates an exact bound project and canonical state object', async () => {
    const handler = makeProjectTrackProgressHandler(engine);
    const input = event(`
# Update
## Action Items
- Ship connector | Owner: Alice | Due: 2026-08-05
## Decisions
- Keep automatic tracking on the server
`);
    await handler(job(input));

    const project = await engine.getPage('projects/connector-rollout', { sourceId: 'default' });
    expect(project?.compiled_truth).toContain('User-authored project context.');
    expect(project?.compiled_truth).toContain('voltmind:tracking-state:begin');
    expect(project?.timeline).toContain('sources/teams/chat-1');
    const actions = await engine.listPages({
      sourceId: 'default',
      slugPrefix: 'state/actions/',
      sort: 'slug',
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.frontmatter?.owner).toBe('Alice');

    const receipts = await engine.executeRaw<{ count: string }>(
      'SELECT count(*)::text AS count FROM project_tracking_receipt_history',
    );
    expect(receipts[0]?.count).toBe('1');
  });

  test('same revision is idempotent and a new revision preserves history', async () => {
    const handler = makeProjectTrackProgressHandler(engine);
    const first = event('- action: Ship connector');
    await handler(job(first));
    await handler(job(first));
    const second = event('- action: Verify connector', '2026-07-31T11:00:00Z');
    await handler(job(second));

    const project = await engine.getPage('projects/connector-rollout', { sourceId: 'default' });
    expect(project?.timeline.match(/microsoft-connector-relay/g)?.length).toBe(2);
    expect(project?.timeline).toContain('supersedes');
    const history = await engine.executeRaw<{ count: string }>(
      'SELECT count(*)::text AS count FROM project_tracking_receipt_history',
    );
    expect(history[0]?.count).toBe('2');
  });

  test('rejects a missing or unregistered page source', async () => {
    const handler = makeProjectTrackProgressHandler(engine);
    const missing = job(event('- action: Do not write'), 'missing-source');
    await expect(handler(missing)).rejects.toThrow(/not registered/);
    missing.data = { ...(missing.data as Record<string, unknown>), page_source_id: undefined };
    await expect(handler(missing)).rejects.toThrow(/page_source_id is required/);
  });
});
