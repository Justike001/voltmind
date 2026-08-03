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
import { resolveSourceEvidenceDirectory, routeSourceEvidenceSlug } from './source-routing.ts';

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

export type TrackingClientOutcome = 'applied' | 'created' | 'review_needed' | 'no_signal' | 'partial';

export interface RegisterTrackingEvidenceInput {
  evidence_slug: string;
  event_id: string;
  event_version?: string;
  evidence_type: SourceEvidenceType;
  tracking_refs?: TrackingReference[];
  client_outcome: TrackingClientOutcome;
  affected_pages?: string[];
}

const TRACKING_TARGET_PREFIXES = [
  'projects/', 'workstreams/', 'state/actions/', 'state/decisions/',
  'state/commitments/', 'state/risks/',
] as const;

function isTrackingTargetSlug(slug: string): boolean {
  return TRACKING_TARGET_PREFIXES.some(prefix => slug.startsWith(prefix));
}

/** Record a client-authored evidence revision. No Markdown is copied and no
 * project/workstream page is mutated; dream/maintain uses this receipt for
 * deterministic auditing and targeted repair. */
export async function registerTrackingEvidence(
  engine: BrainEngine,
  sourceId: string,
  input: RegisterTrackingEvidenceInput,
): Promise<Record<string, unknown>> {
  await requireRegisteredSource(engine, sourceId);
  const evidenceSlug = input.evidence_slug.trim();
  const eventId = input.event_id.trim();
  if (!evidenceSlug || !eventId) throw new Error('evidence_slug and event_id are required');
  if (!(['teams_thread', 'meeting_transcript', 'email', 'calendar_event', 'other'] as string[]).includes(input.evidence_type)) {
    throw new Error(`unsupported evidence_type: ${String(input.evidence_type)}`);
  }
  if (!(['applied', 'created', 'review_needed', 'no_signal', 'partial'] as string[]).includes(input.client_outcome)) {
    throw new Error(`unsupported client_outcome: ${String(input.client_outcome)}`);
  }
  if (input.tracking_refs !== undefined) {
    if (!Array.isArray(input.tracking_refs) || input.tracking_refs.length > 20) {
      throw new Error('tracking_refs must be an array with at most 20 entries');
    }
    for (const ref of input.tracking_refs) {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)
        || typeof ref.provider !== 'string' || !ref.provider.trim()
        || typeof ref.resource !== 'string' || !ref.resource.trim()
        || typeof ref.id !== 'string' || !ref.id.trim()
        || ref.provider.length > 512 || ref.resource.length > 512 || ref.id.length > 512) {
        throw new Error('tracking_refs entries require provider, resource, and id strings of at most 512 characters');
      }
    }
  }
  if (!Array.isArray(input.affected_pages) || input.affected_pages.length > 100) {
    throw new Error('affected_pages must be an array with at most 100 slugs');
  }
  const evidencePage = await engine.getPage(evidenceSlug, { sourceId });
  if (!evidencePage) throw new Error(`Evidence page not found: ${sourceId}:${evidenceSlug}`);
  const evidenceDirectory = await resolveSourceEvidenceDirectory(input.evidence_type, sourceId);
  if (!evidenceDirectory || !evidenceSlug.startsWith(evidenceDirectory)) {
    throw new Error(`Evidence page must be under the ${input.evidence_type} source directory`);
  }
  const affectedPages = Array.from(new Set(input.affected_pages.map(slug => slug.trim()).filter(Boolean)));
  for (const slug of affectedPages) {
    if (!isTrackingTargetSlug(slug)) throw new Error(`affected page is not a project/workstream/state page: ${slug}`);
    const page = await engine.getPage(slug, { sourceId });
    if (!page) throw new Error(`Affected page not found: ${sourceId}:${slug}`);
    const pageType = String((page as unknown as { type?: unknown }).type ?? page.frontmatter?.type ?? '');
    if (!['project', 'workstream', 'action', 'decision', 'commitment', 'risk'].includes(pageType)) {
      throw new Error(`affected page has an unsupported type: ${slug}`);
    }
  }
  const contentHash = evidencePage.content_hash ?? computeContentHash(`${evidencePage.compiled_truth}\n\n${evidencePage.timeline}`);
  const existing = await engine.executeRaw<{ outcome: string; content_hash: string | null; event_version: string | null; target_slug: string }>(
    `SELECT outcome, content_hash, event_version, target_slug FROM project_tracking_receipts
      WHERE page_source_id=$1 AND event_source_id=$2 AND event_kind=$3 AND event_key=$4
        AND target_type='evidence' ORDER BY updated_at DESC LIMIT 1`,
    [sourceId, sourceId, input.evidence_type, eventId],
  );
  const prior = existing[0];
  if (prior && prior.target_slug !== evidenceSlug) {
    throw new Error(`event ${eventId} is already registered to evidence page ${prior.target_slug}`);
  }
  if (prior && prior.content_hash === contentHash && prior.event_version === (input.event_version ?? null)) {
    return { status: 'duplicate', source_id: sourceId, evidence_slug: evidenceSlug, content_hash: contentHash };
  }
  const conflict = !!prior && prior.event_version === (input.event_version ?? null) && prior.content_hash !== contentHash;
  const supersedes = prior?.content_hash && prior.content_hash !== contentHash ? prior.content_hash : null;
  const outcome = conflict ? 'conflict' : 'registered';
  const details = JSON.stringify({
    evidence_type: input.evidence_type,
    tracking_refs: input.tracking_refs ?? [],
    client_outcome: input.client_outcome,
    affected_pages: affectedPages,
    registration: outcome,
  });
  await engine.executeRaw(
    `INSERT INTO project_tracking_receipts
      (page_source_id,event_source_id,event_kind,event_key,target_type,target_slug,event_version,content_hash,evidence_slug,outcome,matched_by,details,last_error,updated_at)
     VALUES ($1,$2,$3,$4,'evidence',$5,$6,$7,$8,$9,'client',$10::text::jsonb,$11,now())
     ON CONFLICT (page_source_id,event_source_id,event_kind,event_key,target_type,target_slug)
     DO UPDATE SET event_version=EXCLUDED.event_version,content_hash=EXCLUDED.content_hash,evidence_slug=EXCLUDED.evidence_slug,
       outcome=EXCLUDED.outcome,matched_by=EXCLUDED.matched_by,details=EXCLUDED.details,last_error=EXCLUDED.last_error,updated_at=now()`,
    [sourceId, sourceId, input.evidence_type, eventId, evidenceSlug, input.event_version ?? null, contentHash, evidenceSlug,
      outcome, details, conflict ? 'same event version has a different evidence hash' : null],
  );
  await engine.executeRaw(
    `INSERT INTO project_tracking_receipt_history
      (page_source_id,event_source_id,event_kind,event_key,target_type,target_slug,event_version,content_hash,evidence_slug,outcome,matched_by,details,last_error,supersedes_content_hash)
     VALUES ($1,$2,$3,$4,'evidence',$5,$6,$7,$8,$9,'client',$10::text::jsonb,$11,$12)
     ON CONFLICT (page_source_id,event_source_id,event_kind,event_key,target_type,target_slug,content_hash) DO NOTHING`,
    [sourceId, sourceId, input.evidence_type, eventId, evidenceSlug, input.event_version ?? null, contentHash, evidenceSlug,
      outcome, details, conflict ? 'same event version has a different evidence hash' : null, supersedes],
  );
  return { status: outcome, source_id: sourceId, evidence_slug: evidenceSlug, content_hash: contentHash, supersedes_content_hash: supersedes };
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
  const routedLeaf = `${input.source_kind}/${identity}`
    .replace(/[^a-zA-Z0-9/_-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/\/{2,}/g, '/')
    .slice(0, 240);
  const routedSlug = input.slug ?? (input.evidence_type
    ? await routeSourceEvidenceSlug(input.evidence_type, routedLeaf, sourceId)
    : undefined);
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
    ...(routedSlug ? { slug: routedSlug } : {}),
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
       WHERE page_source_id=$1 AND outcome IN ('candidate','failed','pending','review_needed','conflict','repairing')`, [sourceId]),
    engine.executeRaw<Record<string, unknown>>(
      `SELECT status, count(*)::int AS count FROM minion_jobs
       WHERE name='subagent' AND data->>'source_id'=$1 AND data->>'tracking_maintenance'='true'
       GROUP BY status ORDER BY status`, [sourceId]),
    engine.executeRaw<{ last_receipt_at: string | null }>(
      `SELECT max(updated_at)::text AS last_receipt_at FROM project_tracking_receipts
       WHERE page_source_id=$1`, [sourceId]),
  ]);
  return {
    source_id: sourceId,
    by_outcome: byOutcome,
    pending_review_or_failed: pending[0]?.count ?? 0,
    maintenance_jobs: jobs,
    last_receipt_at: latest[0]?.last_receipt_at ?? null,
  };
}

export async function reconcileProjectTracking(
  engine: BrainEngine,
  sourceId: string,
  queue: TrackingQueue = new MinionQueue(engine),
): Promise<{ source_id: string; submitted: number; job_id?: number }> {
  await requireRegisteredSource(engine, sourceId);
  if (engine.kind !== 'postgres') throw new Error('project tracking reconcile requires the company-brain Postgres engine');
  const job = await queue.add('tracking_maintenance', { source_id: sourceId }, {
    idempotency_key: `tracking-maintenance:${sourceId}:${new Date().toISOString().slice(0, 13)}`,
  }, { allowProtectedSubmit: true });
  return { source_id: sourceId, submitted: 1, job_id: job.id };
}
