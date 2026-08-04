/**
 * ingest_capture Minion handler tests. Exercises the slug-resolution
 * fallback chain, content-type gating (binary rejection), validation,
 * and the importFromContent integration against an in-memory PGLite.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  defaultSlugForEvent,
  makeIngestCaptureHandler,
} from '../../src/core/minions/handlers/ingest-capture.ts';
import {
  computeContentHash,
  type IngestionEvent,
} from '../../src/core/ingestion/types.ts';
import type { MinionJobContext } from '../../src/core/minions/types.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { registerTrackingEvidence } from '../../src/core/project-tracking-runtime.ts';

let engine: PGLiteEngine;

// 30s hook timeout — when this file runs deep in a shard process that's
// already created ~20 PGLite engines, the WASM cold-start + 95 migrations
// on a fresh DB legitimately exceeds bun's 5s hook default. CI shard 4
// hit this on v0.41.17.0 (95 migrations × 21 files × 1 bun process).
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
});

function makeEvent(overrides: Partial<IngestionEvent> = {}): IngestionEvent {
  const content = overrides.content ?? '# captured thought';
  return {
    source_id: 'webhook-test',
    source_kind: 'webhook',
    source_uri: 'mcp-webhook:client-x:1234',
    received_at: new Date('2026-05-20T12:00:00Z').toISOString(),
    content_type: 'text/markdown',
    content,
    content_hash: overrides.content_hash ?? computeContentHash(content),
    ...overrides,
  };
}

function makeJob(data: Record<string, unknown>): MinionJobContext {
  return {
    id: 1,
    name: 'ingest_capture',
    data,
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

describe('defaultSlugForEvent', () => {
  test('builds inbox/YYYY-MM-DD-<hash6> slug', () => {
    const ev = makeEvent({ content_hash: 'abcdef1234567890'.padEnd(64, '0') });
    const slug = defaultSlugForEvent(ev, new Date('2026-05-20T00:00:00Z'));
    expect(slug).toBe('inbox/2026-05-20-abcdef');
  });

  test('stable for same content (deterministic hash)', () => {
    const ev = makeEvent({ content: 'same thought' });
    const date = new Date('2026-05-20T00:00:00Z');
    expect(defaultSlugForEvent(ev, date)).toBe(defaultSlugForEvent(ev, date));
  });

  test('UTC date math (no tz drift)', () => {
    const ev = makeEvent();
    const slug = defaultSlugForEvent(ev, new Date('2026-01-05T23:59:59Z'));
    expect(slug).toMatch(/^inbox\/2026-01-05-/);
  });
});

describe('ingest_capture handler — slug resolution', () => {
  test('uses caller-provided job.data.slug when present', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'with explicit slug' });
    const result = await handler(makeJob({ event: ev, slug: 'wiki/specific/page' }));
    expect(result.slug).toBe('wiki/specific/page');
    expect(result.status).toBe('imported');
  });

  test('uses event.metadata.slug when set', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'metadata slug', metadata: { slug: 'inbox/custom-from-meta' } });
    const result = await handler(makeJob({ event: ev }));
    expect(result.slug).toBe('inbox/custom-from-meta');
  });

  test('falls back to inbox/YYYY-MM-DD-<hash6> when no slug provided', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'fallback slug' });
    const result = await handler(makeJob({ event: ev }));
    expect(result.slug).toMatch(/^inbox\/\d{4}-\d{2}-\d{2}-[a-f0-9]{6}$/);
  });
});

describe('ingest_capture handler — validation + routing', () => {
  test('throws when event missing', async () => {
    const handler = makeIngestCaptureHandler(engine);
    await expect(handler(makeJob({}))).rejects.toThrow(/job.data.event is required/);
  });

  test('throws on invalid event payload (caught at the handler boundary)', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = { ...makeEvent(), content_hash: 'short' };
    await expect(handler(makeJob({ event: ev }))).rejects.toThrow(/invalid event payload/);
  });

  test('rejects binary content_type with helpful message', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content_type: 'image/*',
      content: '/path/to/screenshot.png',
      content_hash: computeContentHash('/path/to/screenshot.png'),
    });
    await expect(handler(makeJob({ event: ev }))).rejects.toThrow(
      /content_type 'image\/\*' requires a content-type processor/,
    );
  });

  test('untrusted_payload flag round-trips to the result', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'untrusted', untrusted_payload: true });
    const result = await handler(makeJob({ event: ev }));
    expect(result.untrusted_payload).toBe(true);
  });

  test('trusted (default) payload round-trips as false', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'trusted' });
    const result = await handler(makeJob({ event: ev }));
    expect(result.untrusted_payload).toBe(false);
  });

  test('source provenance round-trips into the result', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: 'with provenance',
      source_kind: 'inbox-folder',
      source_uri: '/Users/test/.voltmind/inbox/note.md',
    });
    const result = await handler(makeJob({ event: ev }));
    expect(result.source_kind).toBe('inbox-folder');
    expect(result.source_uri).toBe('/Users/test/.voltmind/inbox/note.md');
  });
});

describe('ingest_capture handler — integration with importFromContent', () => {
  test('imported event lands as a page in the DB', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '---\ntitle: Test Page\n---\n\n# E2E import\n\nbody content',
    });
    const result = await handler(makeJob({ event: ev, slug: 'wiki/e2e-test' }));
    expect(result.status).toBe('imported');

    const page = await engine.getPage('wiki/e2e-test');
    expect(page).not.toBeNull();
    expect(page?.compiled_truth).toContain('E2E import');
  });

  test('repeat ingest of same content returns skipped status (content_hash dedup at importFromContent level)', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: '# stable content' });
    const result1 = await handler(makeJob({ event: ev, slug: 'wiki/stable' }));
    expect(result1.status).toBe('imported');

    const result2 = await handler(makeJob({ event: ev, slug: 'wiki/stable' }));
    expect(result2.status).toBe('skipped');
  });

  test('chunks count is reported on imported events', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const longContent = '---\ntitle: long\n---\n\n' + 'Paragraph.\n\n'.repeat(50);
    const ev = makeEvent({ content: longContent });
    const result = await handler(makeJob({ event: ev, slug: 'wiki/long' }));
    expect(result.chunks).toBeGreaterThan(0);
  });

  test('file references persist on the page and in the normalized index', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '# Teams decision\n\nPlease review the planning deck.',
      file_refs: [{
        schema_version: 1,
        provider: 'microsoft',
        service: 'sharepoint',
        tenant_id: 'tenant-test',
        drive_id: 'drive-test',
        item_id: 'item-test',
        name: 'Planning deck.pptx',
        display_path: '/Shared Documents/Planning/Planning deck.pptx',
        web_url: 'https://tenant.sharepoint.com/sites/test/Planning%20deck.pptx',
        occurrence: {
          platform: 'teams',
          relation: 'attachment',
          conversation_id: 'chat-test',
          message_id: 'message-test',
          source_uri: 'https://teams.microsoft.com/l/message/message-test',
        },
      }],
    });
    const result = await handler(makeJob({ event: ev, slug: 'sources/teams/test' }));
    expect(result.status).toBe('imported');
    const page = await engine.getPage('sources/teams/test');
    expect(page?.compiled_truth).toContain('Planning deck.pptx');
    expect(JSON.stringify(page?.frontmatter)).toContain('drive-test');
    const rows = await engine.executeRaw<{ name: string; display_path: string; message_id: string }>(
      `SELECT efr.name, efr.display_path, per.message_id
         FROM page_external_file_refs per
         JOIN external_file_refs efr ON efr.id = per.file_ref_id
        JOIN pages p ON p.id = per.page_id
        WHERE p.slug = $1`,
      ['sources/teams/test'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Planning deck.pptx');
    expect(rows[0]?.message_id).toBe('message-test');
  });

  test('an empty relay ref set preserves the last known projection', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ref = {
      schema_version: 1 as const,
      provider: 'microsoft' as const,
      service: 'sharepoint' as const,
      tenant_id: 'tenant-preserve',
      drive_id: 'drive-preserve',
      item_id: 'item-preserve',
      name: 'Roadmap.pdf',
      display_path: '/Shared Documents/Roadmap.pdf',
      web_url: 'https://tenant.sharepoint.com/sites/test/Roadmap.pdf',
    };
    await handler(makeJob({
      event: makeEvent({ content: '# Initial', file_refs: [ref] }),
      slug: 'sources/teams/preserve',
    }));
    await handler(makeJob({
      event: makeEvent({ content: '# Updated body', file_refs: [] }),
      slug: 'sources/teams/preserve',
    }));
    const page = await engine.getPage('sources/teams/preserve');
    expect(page?.compiled_truth).toContain('Roadmap.pdf');
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM external_file_refs WHERE item_id = $1`,
      ['item-preserve'],
    );
    expect(rows[0]?.count).toBe('1');
  });

  test('search_file_refs supports exact page reverse lookup', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '# Searchable file',
      file_refs: [{
        schema_version: 1,
        provider: 'microsoft',
        service: 'onedrive',
        tenant_id: 'tenant-search',
        drive_id: 'drive-search',
        item_id: 'item-search',
        name: 'Budget.xlsx',
        display_path: '/Documents/Budget.xlsx',
        web_url: 'https://tenant-my.sharepoint.com/personal/test/Documents/Budget.xlsx',
      }],
    });
    await handler(makeJob({ event: ev, slug: 'sources/outlook/search-file' }));
    const op = operationsByName.search_file_refs;
    const ctx = { engine, config: {}, logger: {}, dryRun: false, remote: true, sourceId: 'default' } as unknown as OperationContext;
    const rows = await op.handler(ctx, { query: 'Budget.xlsx', page_slug: 'sources/outlook/search-file' }) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>).page_slugs).toEqual(['sources/outlook/search-file']);
  });

  test('RaiDrive references persist and are searchable by mapped path', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '# Shared drive file',
      file_refs: [{
        schema_version: 1,
        provider: 'filesystem',
        service: 'raidrive',
        root_key: 'synology-public',
        relative_path: 'Public/Finance/Forecast.xlsx',
        open_path: 'Z:\\Public\\Finance\\Forecast.xlsx',
        name: 'Forecast.xlsx',
        availability: 'accessible',
      }],
    });
    await handler(makeJob({ event: ev, slug: 'sources/teams/raidrive-file' }));
    const op = operationsByName.search_file_refs;
    const ctx = { engine, config: {}, logger: {}, dryRun: false, remote: true, sourceId: 'default' } as unknown as OperationContext;
    const rows = await op.handler(ctx, { query: 'Z:\\Public\\Finance', service: 'raidrive' }) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe('filesystem');
    expect(rows[0]?.root_key).toBe('synology-public');
    expect(rows[0]?.relative_path).toBe('Public/Finance/Forecast.xlsx');
    expect(rows[0]?.web_url).toBeNull();
    expect(rows[0]?.open_path).toBeNull();
  });

  test('RaiDrive references without open_path are searchable by logical locator', async () => {
    const handler = makeIngestCaptureHandler(engine);
    await handler(makeJob({
      event: makeEvent({
        content: '# Logical shared file',
        file_refs: [{
          schema_version: 1,
          provider: 'filesystem',
          service: 'raidrive',
          root_key: 'synology-public',
          relative_path: 'Public/Legal/Agreement.pdf',
          name: 'Agreement.pdf',
          availability: 'unverified',
        }],
      }),
      slug: 'sources/teams/logical-raidrive-file',
    }));
    const op = operationsByName.search_file_refs;
    const ctx = { engine, config: {}, logger: {}, dryRun: false, remote: true, sourceId: 'default' } as unknown as OperationContext;
    const rows = await op.handler(ctx, {
      root_key: 'synology-public',
      relative_path: 'Public/Legal/Agreement.pdf',
    }) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.open_path).toBeNull();
    const page = await engine.getPage('sources/teams/logical-raidrive-file');
    expect(page?.compiled_truth).toContain('synology-public:/Public/Legal/Agreement.pdf');
    expect(page?.compiled_truth).not.toContain('Z:\\');
  });

  test('a RaiDrive file_id preserves identity across rename and move updates', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const baseRef = {
      schema_version: 1 as const,
      provider: 'filesystem' as const,
      service: 'raidrive' as const,
      root_key: 'synology-public',
      file_id: 'synology-file-42',
      relative_path: 'Public/Finance/Draft.xlsx',
      open_path: 'Z:\\Public\\Finance\\Draft.xlsx',
      name: 'Draft.xlsx',
      availability: 'accessible' as const,
    };
    await handler(makeJob({
      event: makeEvent({ content: '# Shared file version 1', file_refs: [baseRef] }),
      slug: 'sources/teams/raidrive-move',
    }));
    await handler(makeJob({
      event: makeEvent({
        content: '# Shared file version 2',
        file_refs: [{
          ...baseRef,
          relative_path: 'Archive/Finance/Final.xlsx',
          open_path: 'Z:\\Archive\\Finance\\Final.xlsx',
          name: 'Final.xlsx',
        }],
      }),
      slug: 'sources/teams/raidrive-move',
    }));
    const rows = await engine.executeRaw<{ count: string; name: string; relative_path: string }>(
      `SELECT count(*) OVER ()::text AS count, name, relative_path
         FROM external_file_refs
        WHERE provider = 'filesystem' AND drive_id = $1 AND item_id = $2`,
      ['synology-public', 'id:synology-file-42'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe('1');
    expect(rows[0]?.name).toBe('Final.xlsx');
    expect(rows[0]?.relative_path).toBe('Archive/Finance/Final.xlsx');
  });

  test('filesystem materialization derives its artifact slug on the host', async () => {
    const handler = makeIngestCaptureHandler(engine);
    await handler(makeJob({
      event: makeEvent({
        content: '# Materialize shared file',
        file_refs: [{
          schema_version: 1,
          provider: 'filesystem',
          service: 'raidrive',
          root_key: 'synology-public',
          relative_path: 'Public/Research/Source.pdf',
          file_id: 'source-pdf-1',
          name: 'Source.pdf',
        }],
      }),
      slug: 'sources/teams/materialize-raidrive',
    }));
    const refs = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM external_file_refs WHERE provider = 'filesystem' AND file_id = $1`,
      ['source-pdf-1'],
    );
    const op = operationsByName.file_ref_materialize;
    const ctx = { engine, config: {}, logger: {}, dryRun: false, remote: true, sourceId: 'default' } as unknown as OperationContext;
    const result = await op.handler(ctx, {
      file_ref_id: refs[0]!.id,
      content: '# Extracted PDF\n\nServer stores Markdown only.',
      observed_etag: 'version-1',
    }) as Record<string, unknown>;
    expect(result.artifact_slug).toMatch(/^artifacts\/filesystem\/[a-f0-9]{24}$/);
    expect(result.artifact_slug).toBe(result.derived_artifact_slug);
    const page = await engine.getPage(String(result.artifact_slug));
    expect(page?.source_uri).toBe('voltmind-file://synology-public/Public/Research/Source.pdf');
  });

  test('source-scoped backfill normalizes mapped paths without persisting a UNC host', async () => {
    const handler = makeIngestCaptureHandler(engine);
    await handler(makeJob({
      event: makeEvent({
        content: '# Legacy mapped path\n\nReview `Z:\\Public\\Planning\\Legacy Plan.xlsx`.',
      }),
      slug: 'sources/teams/legacy-mapped-path',
    }));
    const op = operationsByName.backfill_file_refs;
    const ctx = { engine, config: {}, logger: {}, dryRun: false, remote: true, sourceId: 'default' } as unknown as OperationContext;
    const preview = await op.handler(ctx, {
      dry_run: true,
      root_key: 'synology-public',
      local_root: 'Z:\\',
      unc_share: 'Synology',
    }) as Record<string, unknown>;
    expect(preview.refs_found).toBeGreaterThan(0);
    expect(preview.pages_updated).toBe(0);
    const applied = await op.handler(ctx, {
      root_key: 'synology-public',
      local_root: 'Z:\\',
      unc_share: 'Synology',
    }) as Record<string, unknown>;
    expect(applied.pages_updated).toBeGreaterThan(0);
    const refs = await engine.executeRaw<{ relative_path: string; open_path: string | null }>(
      `SELECT relative_path, open_path FROM external_file_refs
        WHERE provider = 'filesystem' AND root_key = $1 AND relative_path = $2`,
      ['synology-public', 'Public/Planning/Legacy Plan.xlsx'],
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.open_path).toBeNull();
  });

  test('open_path scrub clears legacy observations and rebuilds logical projections', async () => {
    const handler = makeIngestCaptureHandler(engine);
    await handler(makeJob({
      event: makeEvent({
        content: '# Legacy client path',
        file_refs: [{
          schema_version: 1,
          provider: 'filesystem',
          service: 'raidrive',
          root_key: 'synology-public',
          relative_path: 'Public/Legacy/Observed.txt',
          open_path: '\\\\RaiDrive-PrivateUser\\Synology\\Public\\Legacy\\Observed.txt',
          name: 'Observed.txt',
        }],
      }),
      slug: 'sources/teams/legacy-open-path',
    }));
    const op = operationsByName.scrub_file_ref_open_paths;
    const ctx = { engine, config: {}, logger: {}, dryRun: false, remote: true, sourceId: 'default' } as unknown as OperationContext;
    const preview = await op.handler(ctx, {}) as Record<string, unknown>;
    expect(preview.applied).toBe(false);
    expect(preview.refs_with_open_path).toBeGreaterThan(0);
    const applied = await op.handler(ctx, { apply: true }) as Record<string, unknown>;
    expect(applied.applied).toBe(true);
    const refs = await engine.executeRaw<{ open_path: string | null }>(
      `SELECT open_path FROM external_file_refs WHERE root_key = $1 AND relative_path = $2`,
      ['synology-public', 'Public/Legacy/Observed.txt'],
    );
    expect(refs[0]?.open_path).toBeNull();
    const page = await engine.getPage('sources/teams/legacy-open-path');
    expect(page?.compiled_truth).toContain('synology-public:/Public/Legacy/Observed.txt');
    expect(page?.compiled_truth).not.toContain('RaiDrive-PrivateUser');
    expect(JSON.stringify(page?.frontmatter)).not.toContain('open_path');
  });

  test('event id/version state is transactional and rejects same-version replays', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const first = makeEvent({
      content: '# v1',
      event_id: 'teams-event-1',
      event_version: '2026-05-20T12:00:00Z',
    });
    const result1 = await handler(makeJob({ event: first, slug: 'sources/teams/versioned' }));
    expect(result1.status).toBe('imported');
    const result2 = await handler(makeJob({ event: first, slug: 'sources/teams/versioned' }));
    expect(result2.status).toBe('skipped');

    const newer = makeEvent({
      content: '# v2',
      event_id: 'teams-event-1',
      event_version: '2026-05-20T13:00:00Z',
    });
    const result3 = await handler(makeJob({ event: newer, slug: 'sources/teams/versioned' }));
    expect(result3.status).toBe('imported');
    const state = await engine.executeRaw<{ event_version: string; page_id: number | null }>(
      `SELECT event_version, page_id FROM ingestion_event_state
        WHERE source_id = $1 AND source_kind = $2 AND event_id = $3`,
      ['webhook-test', 'webhook', 'teams-event-1'],
    );
    expect(state[0]?.event_version).toBe('2026-05-20T13:00:00Z');
    expect(state[0]?.page_id).toBeGreaterThan(0);
  });

  test('tracking-aware ingest persists evidence without a realtime tracking worker', async () => {
    const calls: Array<{
      name: string;
      data?: Record<string, unknown>;
      opts?: Record<string, unknown>;
      trusted?: { allowProtectedSubmit?: boolean };
    }> = [];
    const queue = {
      async add(name: string, data?: Record<string, unknown>, opts?: Record<string, unknown>, trusted?: { allowProtectedSubmit?: boolean }) {
        calls.push({ name, data, opts, trusted });
        return { id: calls.length };
      },
    };
    const handler = makeIngestCaptureHandler(engine, queue);
    const first = makeEvent({
      content: '# Tracking v1',
      event_id: 'tracking-event-1',
      event_version: '2026-05-20T12:00:00Z',
      tracking_refs: [{ provider: 'teams', resource: 'conversation', id: 'chat-1' }],
    });
    await handler(makeJob({ event: first, slug: 'sources/teams/tracking-versioned' }));
    await handler(makeJob({ event: first, slug: 'sources/teams/tracking-versioned' }));
    const second = makeEvent({
      content: '# Tracking v2',
      event_id: 'tracking-event-1',
      event_version: '2026-05-20T13:00:00Z',
      tracking_refs: first.tracking_refs,
    });
    await handler(makeJob({ event: second, slug: 'sources/teams/tracking-versioned' }));

    expect(calls).toHaveLength(0);
    expect((await handler(makeJob({ event: first, slug: 'sources/teams/tracking-versioned' }))).status).toBe('skipped');
  });

  test("teams connector raw receipt uses evidence identity and client registration is one-row pending-to-registered", async () => {
    const handler = makeIngestCaptureHandler(engine);
    const input = makeEvent({
      source_kind: "teams-connector",
      event_id: "teams-event-same-1",
      event_version: "2026-05-20T12:00:00Z",
      evidence_type: "teams_thread",
      source_id: "default",
      content: "# Teams evidence",
    });
    const slug = "sources/teams/teams-event-same-1";
    expect((await handler(makeJob({ event: input, slug }))).status).toBe("imported");
    const pending = await engine.executeRaw<{ count: number; event_kind: string; outcome: string }>("SELECT count(*)::int AS count, max(event_kind) AS event_kind, max(outcome) AS outcome FROM project_tracking_receipts WHERE page_source_id=$1 AND event_source_id=$1 AND event_key=$2 AND target_slug=$3", ["default", input.event_id!, slug]);
    expect(pending).toEqual([{ count: 1, event_kind: "teams_thread", outcome: "pending" }]);
    const provenance = await engine.executeRaw<{ source_kind: string }>("SELECT details->>'source_kind' AS source_kind FROM project_tracking_receipts WHERE page_source_id=$1 AND event_source_id=$1 AND event_key=$2 AND target_slug=$3", ["default", input.event_id!, slug]);
    expect(provenance).toEqual([{ source_kind: "teams-connector" }]);
    const registered = await registerTrackingEvidence(engine, "default", {
      evidence_slug: slug,
      event_id: input.event_id!,
      event_version: input.event_version,
      evidence_type: "teams_thread",
      client_outcome: "no_signal",
      affected_pages: [],
    });
    expect(registered.status).toBe("registered");
    const finalRows = await engine.executeRaw<{ count: number; event_kind: string; outcome: string }>("SELECT count(*)::int AS count, max(event_kind) AS event_kind, max(outcome) AS outcome FROM project_tracking_receipts WHERE page_source_id=$1 AND event_source_id=$1 AND event_key=$2 AND target_slug=$3", ["default", input.event_id!, slug]);
    expect(finalRows).toEqual([{ count: 1, event_kind: "teams_thread", outcome: "registered" }]);
  });

  test('queue argument is ignored so ingest success is independent of tracking maintenance', async () => {
    const queue = {
      async add() {
        throw new Error('queue must not be called');
      },
    };
    const handler = makeIngestCaptureHandler(engine, queue);
    const input = makeEvent({
      content: '# Dispatch retry',
      event_id: 'tracking-dispatch-1',
      event_version: '2026-05-20T12:00:00Z',
      tracking_refs: [{ provider: 'teams', resource: 'conversation', id: 'chat-retry' }],
    });
    const result = await handler(makeJob({ event: input, slug: 'sources/teams/dispatch-retry' }));
    expect(result.status).toBe('imported');
  });
});
