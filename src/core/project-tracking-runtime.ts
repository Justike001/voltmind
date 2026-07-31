import type { BrainEngine } from './engine.ts';
import { computeContentHash, validateIngestionEvent } from './ingestion/types.ts';
import type {
  IngestionContentType,
  IngestionEvent,
  SourceEvidenceType,
  TrackingReference,
} from './ingestion/types.ts';
import {
  normalizeExternalFileRefs,
  type ExternalFileReferenceV1,
} from './external-file-refs.ts';
import { MinionQueue } from './minions/queue.ts';

export interface TrackingQueue {
  add(
    name: string,
    data?: Record<string, unknown>,
    opts?: Record<string, unknown>,
    trusted?: { allowProtectedSubmit?: boolean },
  ): Promise<{ id: number }>;
}

async function requireRegisteredSource(engine: BrainEngine, sourceId: string): Promise<void> {
  if (!sourceId) throw new Error('project tracking requires an explicit source id');
  const rows = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE id=$1 LIMIT 1', [sourceId]);
  if (rows.length === 0) throw new Error(`Unknown source '${sourceId}'`);
}

export interface SubmitTrackedIngestionInput {
  source_kind: string;
  source_uri: string;
  content: string;
  content_type?: IngestionContentType;
  event_id?: string;
  event_version?: string;
  occurred_at?: string;
  tracking_refs?: TrackingReference[];
  file_refs?: ExternalFileReferenceV1[];
  evidence_type?: SourceEvidenceType;
  page_metadata?: Record<string, unknown>;
  slug?: string;
  untrusted_payload?: boolean;
}

export async function submitTrackedIngestionEvent(
  engine: BrainEngine,
  sourceId: string,
  input: SubmitTrackedIngestionInput,
  queue: TrackingQueue = new MinionQueue(engine),
): Promise<{ source_id: string; status: 'queued' | 'duplicate'; job_id: number }> {
  await requireRegisteredSource(engine, sourceId);
  const fileRefs = input.file_refs === undefined
    ? undefined
    : normalizeExternalFileRefs(input.file_refs);
  const contentHash = computeContentHash(JSON.stringify({
    content: input.content,
    file_refs: fileRefs ?? [],
    tracking_refs: input.tracking_refs ?? [],
    evidence_type: input.evidence_type,
    page_metadata: input.page_metadata ?? {},
  }));
  const event: IngestionEvent = {
    source_id: sourceId,
    source_kind: input.source_kind,
    source_uri: input.source_uri,
    received_at: input.occurred_at ?? new Date().toISOString(),
    content_type: input.content_type ?? 'text/markdown',
    content: input.content,
    content_hash: contentHash,
    ...(input.event_id ? { event_id: input.event_id } : {}),
    ...(input.event_version ? { event_version: input.event_version } : {}),
    ...(fileRefs ? { file_refs: fileRefs } : {}),
    ...(input.tracking_refs ? { tracking_refs: input.tracking_refs } : {}),
    ...(input.evidence_type ? { evidence_type: input.evidence_type } : {}),
    ...(input.page_metadata ? { page_metadata: input.page_metadata } : {}),
    untrusted_payload: input.untrusted_payload ?? true,
  };
  const validationError = validateIngestionEvent(event);
  if (validationError) throw validationError;
  const identity = input.event_id ?? input.source_uri;
  const idempotencyKey = [
    'ingest:tracked', sourceId, input.source_kind, identity,
    input.event_version ?? 'unversioned', contentHash,
  ].join(':');
  const existing = await engine.executeRaw<{ id: number }>(
    'SELECT id FROM minion_jobs WHERE idempotency_key=$1 LIMIT 1',
    [idempotencyKey],
  );
  if (existing[0]?.id !== undefined) {
    return { source_id: sourceId, status: 'duplicate', job_id: existing[0].id };
  }
  const job = await queue.add('ingest_capture', {
    event,
    ...(input.slug ? { slug: input.slug } : {}),
  }, { idempotency_key: idempotencyKey });
  return { source_id: sourceId, status: 'queued', job_id: job.id };
}

export async function getProjectTrackingStatus(engine: BrainEngine, sourceId: string): Promise<Record<string, unknown>> {
  await requireRegisteredSource(engine, sourceId);
  const [byOutcome, pending, jobs, latest] = await Promise.all([
    engine.executeRaw<Record<string, unknown>>(
      `SELECT outcome, count(*)::int AS count FROM project_tracking_receipts
       WHERE page_source_id=$1 GROUP BY outcome ORDER BY outcome`, [sourceId]),
    engine.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM project_tracking_receipts
       WHERE page_source_id=$1 AND outcome IN ('candidate','failed')`, [sourceId]),
    engine.executeRaw<Record<string, unknown>>(
      `SELECT status, count(*)::int AS count FROM minion_jobs
       WHERE name='project_track_progress' AND data->>'page_source_id'=$1
       GROUP BY status ORDER BY status`, [sourceId]),
    engine.executeRaw<{ last_receipt_at: string | null }>(
      `SELECT max(updated_at)::text AS last_receipt_at FROM project_tracking_receipts
       WHERE page_source_id=$1`, [sourceId]),
  ]);
  return {
    source_id: sourceId,
    by_outcome: byOutcome,
    pending_review_or_failed: pending[0]?.count ?? 0,
    tracking_jobs: jobs,
    last_receipt_at: latest[0]?.last_receipt_at ?? null,
  };
}

export async function reconcileProjectTracking(
  engine: BrainEngine,
  sourceId: string,
  queue: TrackingQueue = new MinionQueue(engine),
): Promise<{ source_id: string; submitted: number }> {
  await requireRegisteredSource(engine, sourceId);
  if (engine.kind !== 'postgres') throw new Error('project tracking reconcile requires the company-brain Postgres engine');
  const pages = await engine.listPages({ sourceId, sort: 'updated_asc' });
  let submitted = 0;
  for (const page of pages) {
    const refs = page.frontmatter?.tracking_refs;
    if (!Array.isArray(refs)) continue;
    const content = `${page.compiled_truth}\n\n${page.timeline}`;
    const contentHash = page.content_hash ?? computeContentHash(content);
    const event: IngestionEvent = {
      source_id: sourceId,
      source_kind: page.source_kind ?? 'reconcile',
      source_uri: page.source_uri ?? page.slug,
      received_at: page.updated_at.toISOString(),
      content_type: 'text/markdown',
      content,
      content_hash: contentHash,
      ...(typeof page.frontmatter?.tracking_event_id === 'string' ? { event_id: page.frontmatter.tracking_event_id } : {}),
      ...(typeof page.frontmatter?.tracking_event_version === 'string' ? { event_version: page.frontmatter.tracking_event_version } : {}),
      tracking_refs: refs as TrackingReference[],
      ...(typeof page.frontmatter?.evidence_type === 'string'
        ? { evidence_type: page.frontmatter.evidence_type as SourceEvidenceType }
        : {}),
    };
    const validationError = validateIngestionEvent(event);
    if (validationError) continue;
    await queue.add('project_track_progress', { event, evidence_slug: page.slug, page_source_id: sourceId }, {
      idempotency_key: `project-track-reconcile:${sourceId}:${page.slug}:${contentHash}`,
    }, { allowProtectedSubmit: true });
    submitted++;
  }
  return { source_id: sourceId, submitted };
}
