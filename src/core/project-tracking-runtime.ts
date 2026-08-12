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
  withExternalFileRefsProjection,
  type ExternalFileReferenceV1,
} from './external-file-refs.ts';
import { MinionQueue } from './minions/queue.ts';
import { resolveSourceEvidenceDirectory, routeSourceEvidenceSlug } from './source-routing.ts';
import { computeFileRefsProjectionHash, computeSourcePayloadHash } from './tracking-hashes.ts';
import {
  validateActionAssigneeCoverage,
  type ActionAssigneeProjection,
} from './ingestion/action-assignees.ts';

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
  action_assignments?: ActionAssigneeProjection[];
}

function pageRenderHash(page: { content_hash?: string; compiled_truth: string; timeline: string }): string {
  return page.content_hash ?? computeContentHash(`${page.compiled_truth}\n\n${page.timeline}`);
}

function pageFileRefsHash(page: { file_refs_projection_hash?: string | null; frontmatter: Record<string, unknown> }): string | null {
  if (page.file_refs_projection_hash) return page.file_refs_projection_hash;
  if (!Array.isArray(page.frontmatter.file_refs)) return null;
  try { return computeFileRefsProjectionHash(normalizeExternalFileRefs(page.frontmatter.file_refs)); } catch { return null; }
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
  if (input.action_assignments !== undefined
    && (!Array.isArray(input.action_assignments) || input.action_assignments.length > 100)) {
    throw new Error('action_assignments must be an array with at most 100 entries');
  }
  const actionAssignments = input.action_assignments ?? [];
  const assigneeFindings = await validateActionAssigneeCoverage(
    engine,
    sourceId,
    affectedPages,
    actionAssignments,
  );
  const semanticReviewRequired = assigneeFindings.length > 0
    || input.client_outcome === 'review_needed'
    || input.client_outcome === 'partial';
  const effectiveClientOutcome: TrackingClientOutcome = semanticReviewRequired ? 'review_needed' : input.client_outcome;
  const renderHash = pageRenderHash(evidencePage);
  const sourcePayloadHash = evidencePage.source_payload_hash ?? null;
  const fileRefsProjectionHash = pageFileRefsHash(evidencePage);
  const eventVersion = input.event_version ?? null;
  const existing = await engine.executeRaw<{ outcome: string; content_hash: string | null; render_hash: string | null; source_payload_hash: string | null; file_refs_projection_hash: string | null; event_version: string | null; target_slug: string }>(
    `SELECT outcome, content_hash, render_hash, source_payload_hash, file_refs_projection_hash, event_version, target_slug FROM project_tracking_receipts
      WHERE page_source_id=$1 AND event_source_id=$2 AND event_kind=$3 AND event_key=$4
        AND target_type='evidence' ORDER BY updated_at DESC LIMIT 1`,
    [sourceId, sourceId, input.evidence_type, eventId],
  );
  const prior = existing[0];
  if (prior && prior.target_slug !== evidenceSlug) {
    throw new Error(`event ${eventId} is already registered to evidence page ${prior.target_slug}`);
  }
  const priorRenderHash = prior?.render_hash ?? prior?.content_hash ?? null;
  const sameVersion = !!prior && prior.event_version === eventVersion;
  const sourceEqual = !!prior && !!sourcePayloadHash && !!prior.source_payload_hash && sourcePayloadHash === prior.source_payload_hash;
  const legacyEqual = !!prior && !sourcePayloadHash && !prior.source_payload_hash && priorRenderHash === renderHash;
  const sameRevision = !!prior && sameVersion && (sourceEqual || legacyEqual)
    && priorRenderHash === renderHash && prior.file_refs_projection_hash === fileRefsProjectionHash;
  const recovered = sameRevision && prior?.outcome !== 'registered' && prior?.outcome !== 'verified';
  if (sameRevision && !recovered && !semanticReviewRequired) {
    return { status: 'duplicate', semantic_status: 'complete', source_id: sourceId, evidence_slug: evidenceSlug, content_hash: renderHash, source_payload_hash: sourcePayloadHash };
  }
  const projectionChanged = !!prior && sameVersion && (sourceEqual || legacyEqual)
    && (priorRenderHash !== renderHash || prior.file_refs_projection_hash !== fileRefsProjectionHash);
  const sourceRevisionConflict = !!prior && sameVersion && !!sourcePayloadHash && !!prior.source_payload_hash && sourcePayloadHash !== prior.source_payload_hash;
  const unknownWithoutSnapshot = !!prior && sameVersion && !sourceEqual && !legacyEqual && !sourceRevisionConflict;
  const conflict = sourceRevisionConflict || unknownWithoutSnapshot;
  const conflictKind = sourceRevisionConflict ? 'source_revision_conflict' : unknownWithoutSnapshot ? 'unknown_without_snapshot' : null;
  const supersedes = priorRenderHash && priorRenderHash !== renderHash ? priorRenderHash : null;
  const outcome = conflict
    ? 'conflict'
    : semanticReviewRequired
      ? 'review_needed'
      : (prior && !projectionChanged && !recovered ? prior.outcome : 'registered');
  const snapshotKind = projectionChanged ? 'file_ref_projection' : prior && sameVersion ? 'client_semantic_update' : 'source_ingest';
  const details = JSON.stringify({
    evidence_type: input.evidence_type,
    tracking_refs: input.tracking_refs ?? [],
    client_outcome: effectiveClientOutcome,
    requested_client_outcome: input.client_outcome,
    semantic_status: semanticReviewRequired ? 'review_required' : 'complete',
    affected_pages: affectedPages,
    action_assignments: actionAssignments,
    assignee_coverage_findings: assigneeFindings,
    registration: outcome,
    hash_scheme: sourcePayloadHash ? 'v2' : 'legacy',
    ...(recovered ? { recovered_from: prior?.outcome ?? 'pending' } : {}),
  });
  if (conflict) {
    const conflictDetails = JSON.stringify({ ...JSON.parse(details), registration: 'conflict' });
    if (prior) {
      await engine.executeRaw(
        `UPDATE project_tracking_receipts SET conflict_kind=$5,last_error=$6,updated_at=now()
          WHERE page_source_id=$1 AND event_source_id=$1 AND event_kind=$2 AND event_key=$3
            AND target_type='evidence' AND target_slug=$4`,
        [sourceId, input.evidence_type, eventId, evidenceSlug, conflictKind,
          conflictKind === 'source_revision_conflict' ? 'same event version has a different source payload hash' : 'no pre-projection snapshot proves the legacy hash mapping'],
      );
    }
    await engine.executeRaw(
      `INSERT INTO project_tracking_receipt_history
        (page_source_id,event_source_id,event_kind,event_key,target_type,target_slug,event_version,content_hash,source_payload_hash,render_hash,file_refs_projection_hash,snapshot_kind,conflict_kind,evidence_slug,outcome,matched_by,details,last_error,supersedes_content_hash)
       VALUES ($1,$2,$3,$4,'evidence',$5,$6,$7,$8,$9,$10,'conflict_observation',$11,$5,'conflict','client',$12::text::jsonb,$13,$14)
       ON CONFLICT (page_source_id,event_source_id,event_kind,event_key,target_type,target_slug,content_hash) DO NOTHING`,
      [sourceId, sourceId, input.evidence_type, eventId, evidenceSlug, eventVersion, renderHash, sourcePayloadHash, renderHash,
        fileRefsProjectionHash, conflictKind, conflictDetails,
        conflictKind === 'source_revision_conflict' ? 'same event version has a different source payload hash' : 'no pre-projection snapshot proves the legacy hash mapping', supersedes],
    );
    return {
      status: conflictKind === 'unknown_without_snapshot' ? 'manual_review_required' : 'conflict',
      source_id: sourceId, evidence_slug: evidenceSlug, content_hash: renderHash,
      source_payload_hash: sourcePayloadHash, conflict_kind: conflictKind,
    };
  }
  await engine.executeRaw(
    `INSERT INTO project_tracking_receipts
      (page_source_id,event_source_id,event_kind,event_key,target_type,target_slug,event_version,content_hash,source_payload_hash,render_hash,file_refs_projection_hash,evidence_slug,outcome,matched_by,details,last_error,conflict_kind,updated_at)
     VALUES ($1,$2,$3,$4,'evidence',$5,$6,$7,$8,$9,$10,$11,$12,'client',$13::text::jsonb,$14,NULL,now())
     ON CONFLICT (page_source_id,event_source_id,event_kind,event_key,target_type,target_slug)
     DO UPDATE SET event_version=EXCLUDED.event_version,content_hash=EXCLUDED.content_hash,
       source_payload_hash=EXCLUDED.source_payload_hash,render_hash=EXCLUDED.render_hash,
       file_refs_projection_hash=EXCLUDED.file_refs_projection_hash,evidence_slug=EXCLUDED.evidence_slug,
       outcome=EXCLUDED.outcome,matched_by=EXCLUDED.matched_by,details=EXCLUDED.details,
       last_error=NULL,conflict_kind=NULL,updated_at=now()
       WHERE project_tracking_receipts.event_version IS DISTINCT FROM EXCLUDED.event_version
          OR (project_tracking_receipts.source_payload_hash IS NOT NULL
              AND project_tracking_receipts.source_payload_hash = EXCLUDED.source_payload_hash)
          OR (project_tracking_receipts.source_payload_hash IS NULL
              AND EXCLUDED.source_payload_hash IS NULL
              AND project_tracking_receipts.content_hash = EXCLUDED.content_hash)`,
    [sourceId, sourceId, input.evidence_type, eventId, evidenceSlug, eventVersion, renderHash, sourcePayloadHash,
      renderHash, fileRefsProjectionHash, evidenceSlug, outcome, details, null],
  );
  if (recovered) {
    await engine.executeRaw(
      `UPDATE project_tracking_receipt_history
          SET outcome='registered', matched_by='client', details=$8::text::jsonb, last_error=NULL
        WHERE page_source_id=$1 AND event_source_id=$2 AND event_kind=$3 AND event_key=$4
          AND target_type='evidence' AND target_slug=$5 AND event_version IS NOT DISTINCT FROM $6
          AND content_hash=$7 AND outcome IN ('pending','repairing','review_needed','failed')`,
      [sourceId, sourceId, input.evidence_type, eventId, evidenceSlug, eventVersion, renderHash, details],
    );
  }
  await engine.executeRaw(
    `INSERT INTO project_tracking_receipt_history
      (page_source_id,event_source_id,event_kind,event_key,target_type,target_slug,event_version,content_hash,source_payload_hash,render_hash,file_refs_projection_hash,snapshot_kind,conflict_kind,evidence_slug,outcome,matched_by,details,last_error,supersedes_content_hash)
     VALUES ($1,$2,$3,$4,'evidence',$5,$6,$7,$8,$9,$10,$11,NULL,$5,$12,'client',$13::text::jsonb,$14,$15)
     ON CONFLICT (page_source_id,event_source_id,event_kind,event_key,target_type,target_slug,content_hash) DO NOTHING`,
    [sourceId, sourceId, input.evidence_type, eventId, evidenceSlug, eventVersion, renderHash, sourcePayloadHash,
      renderHash, fileRefsProjectionHash, snapshotKind, outcome, details, null, supersedes],
  );
  return {
    status: outcome,
    semantic_status: semanticReviewRequired ? 'review_required' : 'complete',
    assignee_coverage_findings: assigneeFindings,
    source_id: sourceId,
    evidence_slug: evidenceSlug,
    content_hash: renderHash,
    source_payload_hash: sourcePayloadHash,
    supersedes_content_hash: supersedes,
    ...(recovered ? { recovered: true } : {}),
  };
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
  const sourcePayloadHash = computeSourcePayloadHash({
    content: input.content,
    content_type: input.content_type ?? 'text/markdown',
    evidence_type: input.evidence_type ?? 'other',
  });
  const fileRefsProjectionHash = fileRefs === undefined ? undefined : computeFileRefsProjectionHash(fileRefs);
  // Keep content_hash as the compatibility/idempotency field while making
  // the source-owned meaning explicit in the event payload.
  const contentHash = sourcePayloadHash;
  const event: IngestionEvent = {
    source_id: sourceId,
    source_kind: input.source_kind,
    source_uri: input.source_uri,
    received_at: input.occurred_at ?? new Date().toISOString(),
    content_type: input.content_type ?? 'text/markdown',
    content: input.content,
    content_hash: contentHash,
    source_payload_hash: sourcePayloadHash,
    ...(fileRefsProjectionHash ? { file_refs_projection_hash: fileRefsProjectionHash } : {}),
    hash_scheme: 'v2',
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
    fileRefsProjectionHash ?? 'no-file-refs',
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

export async function listProjectTrackingReceipts(
  engine: BrainEngine,
  sourceId: string,
  opts: { evidenceSlug?: string; outcome?: string; includeHistory?: boolean; includeHashes?: boolean } = {},
): Promise<Record<string, unknown>[]> {
  await requireRegisteredSource(engine, sourceId);
  const where = ['page_source_id=$1', 'target_type=\'evidence\''];
  const params: unknown[] = [sourceId];
  if (opts.evidenceSlug) { params.push(opts.evidenceSlug); where.push(`evidence_slug=$${params.length}`); }
  if (opts.outcome) { params.push(opts.outcome); where.push(`outcome=$${params.length}`); }
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT event_source_id,event_kind,event_key,event_version,evidence_slug,outcome,matched_by,conflict_kind,last_error,
            content_hash,source_payload_hash,render_hash,file_refs_projection_hash,updated_at,
            (SELECT count(*)::int FROM project_tracking_receipt_history h
              WHERE h.page_source_id=r.page_source_id AND h.event_source_id=r.event_source_id
                AND h.event_kind=r.event_kind AND h.event_key=r.event_key
                AND h.target_type=r.target_type AND h.target_slug=r.target_slug) AS history_count
       FROM project_tracking_receipts r WHERE ${where.join(' AND ')}
       ORDER BY updated_at DESC`,
    params,
  );
  const output: Record<string, unknown>[] = [];
  for (const row of rows) {
    const item: Record<string, unknown> = {
      event_id: row.event_key,
      event_version: row.event_version,
      evidence_slug: row.evidence_slug,
      outcome: row.outcome,
      matched_by: row.matched_by,
      conflict_kind: row.conflict_kind,
      last_error: row.last_error,
      history_count: Number(row.history_count ?? 0),
    };
    if (opts.includeHashes) {
      item.source_payload_hash = row.source_payload_hash ?? row.content_hash ?? null;
      item.render_hash = row.render_hash ?? row.content_hash ?? null;
      item.file_refs_projection_hash = row.file_refs_projection_hash ?? null;
    }
    if (opts.includeHistory) {
      item.history = await engine.executeRaw<Record<string, unknown>>(
        `SELECT event_version,content_hash,source_payload_hash,render_hash,file_refs_projection_hash,snapshot_kind,conflict_kind,outcome,matched_by,last_error,created_at
           FROM project_tracking_receipt_history
          WHERE page_source_id=$1 AND event_source_id=$2 AND event_kind=$3 AND event_key=$4
            AND target_type='evidence' AND target_slug=$5 ORDER BY created_at ASC`,
        [sourceId, row.event_source_id, row.event_kind, row.event_key, row.evidence_slug],
      );
    }
    output.push(item);
  }
  return output;
}

export interface ReconcileTrackingProjectionInput {
  evidence_slug: string;
  event_id: string;
  event_version: string;
  old_render_hash: string;
  new_render_hash: string;
  old_file_refs_hash: string;
  new_file_refs_hash: string;
  reason: 'file_ref_projection_only';
}

/** Update a receipt only when a pre-projection page snapshot proves the drift. */
export async function reconcileTrackingProjection(
  engine: BrainEngine,
  sourceId: string,
  input: ReconcileTrackingProjectionInput,
): Promise<Record<string, unknown>> {
  await requireRegisteredSource(engine, sourceId);
  if (input.reason !== 'file_ref_projection_only') throw new Error('unsupported projection reconcile reason');
  const page = await engine.getPage(input.evidence_slug, { sourceId });
  if (!page) throw new Error(`Evidence page not found: ${sourceId}:${input.evidence_slug}`);
  const currentFileHash = pageFileRefsHash(page);
  if (page.content_hash !== input.new_render_hash || currentFileHash !== input.new_file_refs_hash || !page.source_payload_hash) {
    return { status: 'manual_review_required', reason: 'current_page_hashes_do_not_match' };
  }
  const stripProjection = (text: string) => withExternalFileRefsProjection(text, []);
  const currentFrontmatter = { ...page.frontmatter };
  delete currentFrontmatter.file_refs;
  delete currentFrontmatter.file_refs_version;
  const snapshots = await engine.executeRaw<{
    compiled_truth: string; timeline: string; frontmatter: Record<string, unknown>;
    content_hash: string | null; source_payload_hash: string | null; file_refs_projection_hash: string | null;
  }>(
    `SELECT pv.compiled_truth,pv.timeline,pv.frontmatter,pv.content_hash,pv.source_payload_hash,pv.file_refs_projection_hash
       FROM page_versions pv WHERE pv.page_id=$1 AND pv.content_hash=$2
         AND pv.source_payload_hash=$3 AND pv.file_refs_projection_hash=$4
       ORDER BY pv.snapshot_at DESC LIMIT 1`,
    [page.id, input.old_render_hash, page.source_payload_hash, input.old_file_refs_hash],
  );
  const snapshot = snapshots[0];
  if (!snapshot) return { status: 'manual_review_required', reason: 'pre_projection_snapshot_missing' };
  const oldFrontmatter = { ...(snapshot.frontmatter ?? {}) };
  delete oldFrontmatter.file_refs;
  delete oldFrontmatter.file_refs_version;
  if (stripProjection(snapshot.compiled_truth) !== stripProjection(page.compiled_truth)
    || snapshot.timeline !== page.timeline
    || JSON.stringify(oldFrontmatter) !== JSON.stringify(currentFrontmatter)) {
    return { status: 'manual_review_required', reason: 'body_or_non_file_projection_changed' };
  }
  return await engine.transaction(async (tx) => {
    const receipts = await tx.executeRaw<{ outcome: string; source_payload_hash: string | null; event_version: string | null; target_slug: string }>(
      `SELECT outcome,source_payload_hash,event_version,target_slug FROM project_tracking_receipts
        WHERE page_source_id=$1 AND event_source_id=$1 AND event_key=$2 AND target_type='evidence' FOR UPDATE`,
      [sourceId, input.event_id],
    );
    const receipt = receipts.find((row) => row.target_slug === input.evidence_slug);
    if (!receipt || receipt.event_version !== input.event_version || receipt.source_payload_hash !== page.source_payload_hash) {
      return { status: 'manual_review_required', reason: 'receipt_identity_or_source_hash_mismatch' };
    }
    await tx.executeRaw(
      `UPDATE project_tracking_receipts SET content_hash=$4,render_hash=$4,file_refs_projection_hash=$5,updated_at=now()
        WHERE page_source_id=$1 AND event_source_id=$1 AND event_key=$2 AND target_type='evidence' AND target_slug=$3`,
      [sourceId, input.event_id, input.evidence_slug, input.new_render_hash, input.new_file_refs_hash],
    );
    await tx.executeRaw(
      `INSERT INTO project_tracking_receipt_history
        (page_source_id,event_source_id,event_kind,event_key,target_type,target_slug,event_version,content_hash,source_payload_hash,render_hash,file_refs_projection_hash,snapshot_kind,conflict_kind,evidence_slug,outcome,matched_by,details)
        SELECT page_source_id,event_source_id,event_kind,event_key,target_type,target_slug,event_version,$4,source_payload_hash,$4,$5,'file_ref_projection',NULL,evidence_slug,outcome,'projection_reconcile',details
         FROM project_tracking_receipts WHERE page_source_id=$1 AND event_source_id=$1 AND event_key=$2 AND target_type='evidence' AND target_slug=$3
       ON CONFLICT (page_source_id,event_source_id,event_kind,event_key,target_type,target_slug,content_hash) DO NOTHING`,
      [sourceId, input.event_id, input.evidence_slug, input.new_render_hash, input.new_file_refs_hash],
    );
    return { status: 'reconciled', source_id: sourceId, evidence_slug: input.evidence_slug };
  });
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
