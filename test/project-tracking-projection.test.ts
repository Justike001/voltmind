import { beforeAll, beforeEach, afterAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { registerTrackingEvidence, listProjectTrackingReceipts, reconcileTrackingProjection } from '../src/core/project-tracking-runtime.ts';
import { computeSourcePayloadHash, computeFileRefsProjectionHash } from '../src/core/tracking-hashes.ts';
import { normalizeExternalFileRefs, type ExternalFileReferenceV1 } from '../src/core/external-file-refs.ts';

let engine: PGLiteEngine;
const SLUG = 'sources/teams/projection-event';
const EVENT_ID = 'projection-event-1';
const V1 = '2026-08-01T10:00:00Z';

const fileA = normalizeExternalFileRefs([{
  schema_version: 1,
  provider: 'microsoft',
  service: 'sharepoint',
  tenant_id: 'tenant-a',
  drive_id: 'drive-a',
  item_id: 'item-a',
  name: 'Plan.xlsx',
  display_path: '/Shared/Plan.xlsx',
  web_url: 'https://sharepoint.example/plan',
}])[0] as ExternalFileReferenceV1;
const fileB = normalizeExternalFileRefs([{
  ...fileA,
  name: 'Plan - renamed.xlsx',
  display_path: '/Shared/Archive/Plan - renamed.xlsx',
  web_url: 'https://sharepoint.example/plan?TeamsCID=temporary-observation',
}])[0] as ExternalFileReferenceV1;

function sourceHash(content: string): string {
  return computeSourcePayloadHash({ content, content_type: 'text/markdown', evidence_type: 'teams_thread' });
}

function renderHash(content: string, fileRefs: ExternalFileReferenceV1[] = []): string {
  return computeSourcePayloadHash({ content: `${content}\n${fileRefs.map((ref) => ref.name).join('|')}`, content_type: 'render', evidence_type: 'page' });
}

async function putEvidence(opts: {
  content: string;
  version?: string;
  sourcePayloadHash?: string | null;
  refs?: ExternalFileReferenceV1[];
}): Promise<void> {
  const refs = opts.refs ?? [];
  await engine.putPage(SLUG, {
    type: 'source_teams',
    title: 'Projection event',
    compiled_truth: opts.content,
    timeline: '',
    frontmatter: { evidence_type: 'teams_thread', file_refs: refs },
    content_hash: renderHash(opts.content, refs),
    source_payload_hash: opts.sourcePayloadHash,
    file_refs_projection_hash: computeFileRefsProjectionHash(refs),
  }, { sourceId: 'default' });
}

async function register(version = V1) {
  return registerTrackingEvidence(engine, 'default', {
    evidence_slug: SLUG,
    event_id: EVENT_ID,
    event_version: version,
    evidence_type: 'teams_thread',
    client_outcome: 'no_signal',
    affected_pages: [],
  });
}

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

describe('project tracking source/render hash separation', () => {
  test('same source payload with changed file projection stays one non-conflicting receipt', async () => {
    const source = sourceHash('same Teams body');
    await putEvidence({ content: 'same Teams body', sourcePayloadHash: source, refs: [fileA] });
    expect((await register()).status).toBe('registered');
    await engine.createVersion(SLUG, { sourceId: 'default', snapshotKind: 'file_ref_projection' });
    await putEvidence({ content: 'same Teams body', sourcePayloadHash: source, refs: [fileB] });
    const result = await register();
    expect(result.status).toBe('registered');
    const current = await engine.executeRaw<{ outcome: string; source_payload_hash: string; render_hash: string; conflict_kind: string | null }>(
      `SELECT outcome,source_payload_hash,render_hash,conflict_kind FROM project_tracking_receipts WHERE target_type='evidence'`,
    );
    expect(current).toHaveLength(1);
    expect(current[0]?.outcome).toBe('registered');
    expect(current[0]?.source_payload_hash).toBe(source);
    expect(current[0]?.conflict_kind).toBeNull();
    const history = await engine.executeRaw<{ snapshot_kind: string; conflict_kind: string | null }>(
      `SELECT snapshot_kind,conflict_kind FROM project_tracking_receipt_history ORDER BY id`,
    );
    expect(history.map((row) => row.snapshot_kind)).toEqual(['source_ingest', 'file_ref_projection']);
    expect(history[1]?.conflict_kind).toBeNull();
  });

  test('same event version with changed source payload preserves canonical current receipt', async () => {
    const first = sourceHash('first body');
    await putEvidence({ content: 'first body', sourcePayloadHash: first });
    await register();
    const old = await engine.executeRaw<{ render_hash: string }>(`SELECT render_hash FROM project_tracking_receipts WHERE target_type='evidence'`);
    await putEvidence({ content: 'changed body', sourcePayloadHash: sourceHash('changed body') });
    const result = await register();
    expect(result.status).toBe('conflict');
    const current = await engine.executeRaw<{ source_payload_hash: string; render_hash: string; outcome: string; conflict_kind: string }>(`SELECT source_payload_hash,render_hash,outcome,conflict_kind FROM project_tracking_receipts WHERE target_type='evidence'`);
    expect(current[0]).toEqual({ source_payload_hash: first, render_hash: old[0]?.render_hash, outcome: 'registered', conflict_kind: 'source_revision_conflict' });
    expect((await engine.executeRaw<{ conflict_kind: string }>(`SELECT conflict_kind FROM project_tracking_receipt_history ORDER BY id DESC LIMIT 1`))[0]?.conflict_kind).toBe('source_revision_conflict');
  });

  test('new event version becomes current while the old revision remains in history', async () => {
    await putEvidence({ content: 'v1', sourcePayloadHash: sourceHash('v1') });
    await register(V1);
    const second = sourceHash('v2');
    await putEvidence({ content: 'v2', sourcePayloadHash: second });
    expect((await register('2026-08-02T10:00:00Z')).status).toBe('registered');
    const current = await engine.executeRaw<{ event_version: string; source_payload_hash: string }>(`SELECT event_version,source_payload_hash FROM project_tracking_receipts WHERE target_type='evidence'`);
    expect(current[0]).toEqual({ event_version: '2026-08-02T10:00:00Z', source_payload_hash: second });
    expect((await engine.executeRaw<{ count: number }>(`SELECT count(*)::int AS count FROM project_tracking_receipt_history`))[0]?.count).toBe(2);
  });

  test('legacy same-version drift without a source snapshot remains manual review', async () => {
    await putEvidence({ content: 'legacy body', sourcePayloadHash: null });
    await register();
    await putEvidence({ content: 'legacy body with projection drift', sourcePayloadHash: null });
    expect((await register()).status).toBe('manual_review_required');
    expect((await engine.executeRaw<{ outcome: string; conflict_kind: string | null }>(`SELECT outcome,conflict_kind FROM project_tracking_receipts WHERE target_type='evidence'`))[0]).toEqual({ outcome: 'registered', conflict_kind: 'unknown_without_snapshot' });
  });

  test('projection reconcile requires and uses a pre-projection snapshot', async () => {
    const source = sourceHash('projection-only body');
    const oldFileHash = computeFileRefsProjectionHash([fileA]);
    const newFileHash = computeFileRefsProjectionHash([fileB]);
    await putEvidence({ content: 'projection-only body', sourcePayloadHash: source, refs: [fileA] });
    await register();
    const oldPage = await engine.getPage(SLUG, { sourceId: 'default' });
    const oldRender = oldPage?.content_hash ?? '';
    await engine.createVersion(SLUG, { sourceId: 'default', snapshotKind: 'file_ref_projection' });
    await putEvidence({ content: 'projection-only body', sourcePayloadHash: source, refs: [fileB] });
    const newPage = await engine.getPage(SLUG, { sourceId: 'default' });
    const result = await reconcileTrackingProjection(engine, 'default', {
      evidence_slug: SLUG, event_id: EVENT_ID, event_version: V1,
      old_render_hash: oldRender, new_render_hash: newPage?.content_hash ?? '',
      old_file_refs_hash: oldFileHash, new_file_refs_hash: newFileHash,
      reason: 'file_ref_projection_only',
    });
    expect(result.status).toBe('reconciled');
    expect((await listProjectTrackingReceipts(engine, 'default', { includeHistory: true, includeHashes: true }))[0]?.history_count).toBe(2);
  });

  test('stable SharePoint item variants normalize to one logical ref', () => {
    const refs = normalizeExternalFileRefs([fileA, fileB]);
    expect(refs).toHaveLength(1);
    expect(computeFileRefsProjectionHash(refs)).toBe(computeFileRefsProjectionHash([refs[0]!]))
  });

  test('projection reconcile without a snapshot returns manual review and leaves the receipt unchanged', async () => {
    const source = sourceHash('no snapshot body');
    await putEvidence({ content: 'no snapshot body', sourcePayloadHash: source, refs: [fileA] });
    await register();
    await putEvidence({ content: 'no snapshot body', sourcePayloadHash: source, refs: [fileB] });
    const page = await engine.getPage(SLUG, { sourceId: 'default' });
    const result = await reconcileTrackingProjection(engine, 'default', {
      evidence_slug: SLUG, event_id: EVENT_ID, event_version: V1,
      old_render_hash: 'missing-old-render', new_render_hash: page?.content_hash ?? '',
      old_file_refs_hash: 'missing-old-files', new_file_refs_hash: computeFileRefsProjectionHash([fileB]),
      reason: 'file_ref_projection_only',
    });
    expect(result.status).toBe('manual_review_required');
    expect((await engine.executeRaw<{ outcome: string }>(`SELECT outcome FROM project_tracking_receipts WHERE target_type='evidence'`))[0]?.outcome).toBe('registered');
  });

  test('concurrent same-event registration leaves one current receipt and preserves history', async () => {
    await putEvidence({ content: 'concurrent body', sourcePayloadHash: sourceHash('concurrent body') });
    const results = await Promise.all([register(), register()]);
    expect(results.every((result) => result.status === 'registered' || result.status === 'duplicate')).toBe(true);
    expect((await engine.executeRaw<{ count: number }>(`SELECT count(*)::int AS count FROM project_tracking_receipts WHERE target_type='evidence'`))[0]?.count).toBe(1);
    expect((await engine.executeRaw<{ count: number }>(`SELECT count(*)::int AS count FROM project_tracking_receipt_history`))[0]?.count).toBe(1);
  });
});
