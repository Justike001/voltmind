import type { BrainEngine } from '../../engine.ts';
import type { MinionJobContext } from '../types.ts';
import type { IngestionEvent } from '../../ingestion/types.ts';
import {
  appendTrackingTimeline,
  extractProgressDelta,
  resolveTrackingTargets,
  trackingReviewPageContent,
  upsertTrackingState,
  type TrackingOutcome,
} from '../../project-tracking.ts';

interface TrackJobData {
  event?: IngestionEvent;
  evidence_slug?: string;
  page_source_id?: string;
}

function isoDate(value: string | undefined): string {
  const date = value ? new Date(value) : new Date();
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function eventKey(event: IngestionEvent): string {
  return event.event_id?.trim() || event.content_hash;
}

function sourceCitation(event: IngestionEvent, evidenceSlug: string): string {
  return `${event.source_kind}:${event.source_uri} ([[${evidenceSlug}]])`;
}

function shouldRefreshWorkstreamState(summary: string, status?: string): boolean {
  if (status) return true;
  return /direction|priority|portfolio|cross[- ]project|strategy|roadmap|方向|优先级|组合|跨项目|战略|路线图|risk|风险/i.test(summary);
}

async function resolvePageSource(engine: BrainEngine, explicit?: string): Promise<string> {
  if (!explicit) {
    throw new Error('project_track_progress: page_source_id is required; implicit/default source fallback is forbidden');
  }
  const rows = await engine.executeRaw<{ id: string }>(
    'SELECT id FROM sources WHERE id = $1 LIMIT 1',
    [explicit],
  );
  if (rows.length === 0) {
    throw new Error(`project_track_progress: page source '${explicit}' is not registered`);
  }
  return explicit;
}

async function recordReceipt(
  engine: BrainEngine,
  args: {
    pageSourceId: string;
    event: IngestionEvent;
    targetType: 'project' | 'workstream' | 'review';
    targetSlug: string;
    evidenceSlug: string;
    outcome: TrackingOutcome;
    matchedBy?: string;
    details?: Record<string, unknown>;
    error?: string;
  },
): Promise<void> {
  const details = JSON.stringify(args.details ?? {});
  const previous = await engine.executeRaw<{ content_hash: string | null }>(
    `SELECT content_hash FROM project_tracking_receipts
     WHERE page_source_id=$1 AND event_source_id=$2 AND event_kind=$3
       AND event_key=$4 AND target_type=$5 AND target_slug=$6`,
    [args.pageSourceId, args.event.source_id, args.event.source_kind, eventKey(args.event),
      args.targetType, args.targetSlug],
  );
  const supersedes = previous[0]?.content_hash
    && previous[0].content_hash !== args.event.content_hash
    ? previous[0].content_hash
    : null;
  await engine.executeRaw(
    `INSERT INTO project_tracking_receipts
      (page_source_id, event_source_id, event_kind, event_key, target_type, target_slug,
       event_version, content_hash, evidence_slug, outcome, matched_by, details, last_error, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text::jsonb,$13,now())
     ON CONFLICT (page_source_id, event_source_id, event_kind, event_key, target_type, target_slug)
     DO UPDATE SET event_version=EXCLUDED.event_version, content_hash=EXCLUDED.content_hash,
       evidence_slug=EXCLUDED.evidence_slug, outcome=EXCLUDED.outcome, matched_by=EXCLUDED.matched_by,
       details=EXCLUDED.details, last_error=EXCLUDED.last_error, updated_at=now()`,
    [args.pageSourceId, args.event.source_id, args.event.source_kind, eventKey(args.event), args.targetType,
      args.targetSlug, args.event.event_version ?? null, args.event.content_hash, args.evidenceSlug,
      args.outcome, args.matchedBy ?? null, details, args.error ?? null],
  );
  await engine.executeRaw(
    `INSERT INTO project_tracking_receipt_history
      (page_source_id, event_source_id, event_kind, event_key, target_type, target_slug,
       event_version, content_hash, evidence_slug, outcome, matched_by, details,
       last_error, supersedes_content_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text::jsonb,$13,$14)
     ON CONFLICT (
       page_source_id, event_source_id, event_kind, event_key,
       target_type, target_slug, content_hash
     ) DO NOTHING`,
    [args.pageSourceId, args.event.source_id, args.event.source_kind, eventKey(args.event),
      args.targetType, args.targetSlug, args.event.event_version ?? null,
      args.event.content_hash, args.evidenceSlug, args.outcome, args.matchedBy ?? null,
      details, args.error ?? null, supersedes],
  );
}

async function alreadyApplied(engine: BrainEngine, pageSourceId: string, event: IngestionEvent, targetType: string, targetSlug: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ content_hash: string | null; event_version: string | null; outcome: string }>(
    `SELECT content_hash, event_version, outcome FROM project_tracking_receipts
     WHERE page_source_id=$1 AND event_source_id=$2 AND event_kind=$3 AND event_key=$4 AND target_type=$5 AND target_slug=$6`,
    [pageSourceId, event.source_id, event.source_kind, eventKey(event), targetType, targetSlug],
  );
  const row = rows[0];
  return !!row && row.outcome === 'applied' && row.content_hash === event.content_hash && row.event_version === (event.event_version ?? null);
}

async function priorContentHash(
  engine: BrainEngine,
  pageSourceId: string,
  event: IngestionEvent,
  targetType: string,
  targetSlug: string,
): Promise<string | null> {
  const rows = await engine.executeRaw<{ content_hash: string | null }>(
    `SELECT content_hash FROM project_tracking_receipts
     WHERE page_source_id=$1 AND event_source_id=$2 AND event_kind=$3 AND event_key=$4 AND target_type=$5 AND target_slug=$6`,
    [pageSourceId, event.source_id, event.source_kind, eventKey(event), targetType, targetSlug],
  );
  return rows[0]?.content_hash ?? null;
}

interface StateObjectWriteResult {
  pages: string[];
  ambiguous: Array<{ type: string; title: string; candidates: string[] }>;
}

async function writeStateObject(engine: BrainEngine, sourceId: string, targetSlug: string, delta: ReturnType<typeof extractProgressDelta>, date: string, citation: string): Promise<StateObjectWriteResult> {
  const created: string[] = [];
  const ambiguous: StateObjectWriteResult['ambiguous'] = [];
  for (const object of delta.stateObjects) {
    const prefix = `state/${object.type}s/`;
    const matches = (await engine.listPages({ sourceId, slugPrefix: prefix, sort: 'slug' }))
      .filter(page => page.frontmatter?.related_project === targetSlug)
      .filter(page => {
        if (page.frontmatter?.tracking_key === object.key) return true;
        const sameTitle = page.title.trim().toLocaleLowerCase() === object.title.trim().toLocaleLowerCase();
        const existingOwner = typeof page.frontmatter?.owner === 'string'
          ? page.frontmatter.owner.trim().toLocaleLowerCase()
          : '';
        const incomingOwner = object.owner?.trim().toLocaleLowerCase() ?? '';
        return sameTitle && (!incomingOwner || !existingOwner || incomingOwner === existingOwner);
      });
    // Multiple canonical candidates require human review; never pick the
    // first page based on list ordering.
    if (matches.length > 1) {
      ambiguous.push({ type: object.type, title: object.title, candidates: matches.map(page => page.slug) });
      continue;
    }
    const existing = matches[0];
    const slug = existing?.slug ?? `${prefix}${date}-${object.key.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)}`;
    const page = existing;
    const frontmatter: Record<string, unknown> = {
      ...(page?.frontmatter ?? {}),
      type: object.type,
      title: object.title,
      status: object.status ?? (page?.frontmatter?.status ?? 'open'),
      related_project: targetSlug,
      tracking_key: object.key,
      ...(object.owner ? { owner: object.owner } : {}),
      ...(object.due ? { due: object.due } : {}),
      source_refs: Array.from(new Set([...(Array.isArray(page?.frontmatter?.source_refs) ? page!.frontmatter!.source_refs as unknown[] : []), citation])),
    };
    const content = page?.compiled_truth ?? '';
    const timeline = appendTrackingTimeline(page?.timeline ?? '', date, object.body, citation);
    const renderedObject = `${object.body} [Source: ${citation}]`;
    await engine.putPage(slug, {
      type: object.type,
      title: object.title,
      compiled_truth: content.includes(renderedObject)
        ? content
        : `${content.trim()}\n\n${renderedObject}`.trim(),
      timeline,
      frontmatter,
    }, { sourceId });
    created.push(slug);
  }
  return { pages: created, ambiguous };
}

async function recordStateObjectReview(
  engine: BrainEngine,
  sourceId: string,
  evidenceSlug: string,
  event: IngestionEvent,
  items: StateObjectWriteResult['ambiguous'],
  date: string,
  citation: string,
): Promise<void> {
  if (items.length === 0) return;
  const reviewSlug = 'state/indexes/project-tracking-review';
  await engine.executeRaw(
    `SELECT pg_advisory_xact_lock(hashtext('project-track-review:' || $1))`,
    [sourceId],
  );
  const page = await engine.getPage(reviewSlug, { sourceId });
  const prior = Array.isArray(page?.frontmatter?.state_object_candidates)
    ? page.frontmatter.state_object_candidates as Array<Record<string, unknown>>
    : [];
  const incoming = items.map(item => ({
    ...item,
    evidence_slug: evidenceSlug,
    event_key: eventKey(event),
    observed_at: event.received_at,
  }));
  const merged = [...prior, ...incoming].filter((item, index, all) =>
    all.findIndex(other =>
      other.event_key === item.event_key
      && other.type === item.type
      && other.title === item.title) === index);
  await engine.putPage(reviewSlug, {
    type: 'index',
    title: 'Project Tracking Review',
    compiled_truth: page?.compiled_truth ?? 'Ambiguous project tracking updates awaiting review.',
    timeline: appendTrackingTimeline(
      page?.timeline ?? '',
      date,
      `Ambiguous state object from ${evidenceSlug}`,
      citation,
    ),
    frontmatter: {
      ...(page?.frontmatter ?? {}),
      status: 'active',
      state_object_candidates: merged,
    },
  }, { sourceId });
}

export function makeProjectTrackProgressHandler(engine: BrainEngine) {
  return async function projectTrackProgressHandler(job: MinionJobContext): Promise<Record<string, unknown>> {
    const data = job.data as TrackJobData;
    if (!data.event) throw new Error('project_track_progress: job.data.event is required');
    const event = data.event;
    const pageSourceId = await resolvePageSource(engine, data.page_source_id);
    const evidenceSlug = data.evidence_slug ?? `inbox/${event.content_hash.slice(0, 12)}`;
    const date = isoDate(event.received_at);
    const citation = sourceCitation(event, evidenceSlug);
    const resolved = await resolveTrackingTargets(
      engine,
      pageSourceId,
      event.tracking_refs ?? [],
      event.content,
      {
        ...(event.metadata ?? {}),
        ...(event.page_metadata ?? {}),
      },
    );
    if (resolved.targets.length === 0) {
      const candidates = resolved.candidates;
      const reviewSlug = 'state/indexes/project-tracking-review';
      const existingReview = await engine.getPage(reviewSlug, { sourceId: pageSourceId });
      const existingCandidates = Array.isArray(existingReview?.frontmatter?.tracking_candidates)
        ? existingReview.frontmatter.tracking_candidates as Array<Record<string, unknown>>
        : [];
      const normalizedExisting = existingCandidates.map(candidate => ({
        slug: String(candidate.slug),
        type: candidate.type === 'workstream' ? 'workstream' as const : 'project' as const,
        title: String(candidate.title ?? candidate.slug),
        score: Number(candidate.score) || 0,
        reason: String(candidate.reason ?? 'related project/workstream text'),
        evidence_slug: String(candidate.evidence_slug ?? ''),
        event_key: String(candidate.event_key ?? ''),
        observed_at: String(candidate.observed_at ?? ''),
        tracking_refs: Array.isArray(candidate.tracking_refs) ? candidate.tracking_refs : [],
      }));
      const attributedCandidates = candidates.map(candidate => ({
          slug: String(candidate.slug),
          type: candidate.type === 'workstream' ? 'workstream' as const : 'project' as const,
          title: String(candidate.title),
          score: Number(candidate.score) || 0,
          reason: String(candidate.reason ?? 'related project/workstream text'),
          evidence_slug: evidenceSlug,
          event_key: eventKey(event),
          observed_at: event.received_at,
          tracking_refs: event.tracking_refs ?? [],
        }));
      const mergedCandidates = [...normalizedExisting, ...attributedCandidates]
        .filter((candidate, index, all) => all.findIndex(other =>
          other.slug === candidate.slug
          && other.evidence_slug === candidate.evidence_slug
          && other.event_key === candidate.event_key) === index);
      const reviewContent = trackingReviewPageContent(mergedCandidates, evidenceSlug, date);
      await engine.putPage(reviewSlug, {
        type: 'index',
        title: 'Project Tracking Review',
        compiled_truth: reviewContent.split('\n\n').slice(1).join('\n\n'),
        timeline: appendTrackingTimeline(
          existingReview?.timeline ?? '',
          date,
          `Review candidate from ${evidenceSlug}`,
          citation,
        ),
        frontmatter: {
          ...(existingReview?.frontmatter ?? {}),
          status: 'active',
          tracking_candidates: mergedCandidates,
          source_refs: Array.from(new Set([
            ...(Array.isArray(existingReview?.frontmatter?.source_refs) ? existingReview!.frontmatter!.source_refs as unknown[] : []),
            evidenceSlug,
          ])),
        },
      }, { sourceId: pageSourceId });
      await recordReceipt(engine, { pageSourceId, event, targetType: 'review', targetSlug: reviewSlug, evidenceSlug, outcome: 'candidate', details: { candidates: mergedCandidates } });
      return { outcome: 'candidate', candidates: mergedCandidates.length, review_slug: reviewSlug };
    }

    const delta = extractProgressDelta(event.content);
    const effects: Record<string, unknown> = { state_objects: [] };
    for (const target of resolved.targets) {
      try {
        const stateObjects = await engine.transaction(async (tx) => {
          // Serialize read/modify/write for a single source+target. Otherwise
          // two Teams events can both read the same page and the later commit
          // silently drops the earlier Timeline entry.
          await tx.executeRaw(
            `SELECT pg_advisory_xact_lock(hashtext('project-track:' || $1 || ':' || $2))`,
            [pageSourceId, target.slug],
          );
          if (await alreadyApplied(tx, pageSourceId, event, target.type, target.slug)) {
            return { pages: [], ambiguous: [] } satisfies StateObjectWriteResult;
          }
          const page = await tx.getPage(target.slug, { sourceId: pageSourceId });
          if (!page) return { pages: [], ambiguous: [] } satisfies StateObjectWriteResult;
          const previousHash = await priorContentHash(tx, pageSourceId, event, target.type, target.slug);
          const timelineSummary = previousHash && previousHash !== event.content_hash
            ? `${delta.summary} (supersedes ${previousHash.slice(0, 12)})`
            : delta.summary;
          const compiledTruth = target.type === 'project' || shouldRefreshWorkstreamState(delta.summary, delta.status)
            ? upsertTrackingState(page.compiled_truth ?? '', delta, citation)
            : (page.compiled_truth ?? '');
          const timeline = appendTrackingTimeline(page.timeline ?? '', date, timelineSummary, citation);
          await tx.putPage(target.slug, {
            type: target.type,
            title: page.title,
            compiled_truth: compiledTruth,
            timeline,
            frontmatter: page.frontmatter,
          }, { sourceId: pageSourceId });
          const objects = target.type === 'project'
            ? await writeStateObject(tx, pageSourceId, target.slug, delta, date, citation)
            : { pages: [], ambiguous: [] };
          await recordStateObjectReview(
            tx,
            pageSourceId,
            evidenceSlug,
            event,
            objects.ambiguous,
            date,
            citation,
          );
          await recordReceipt(tx, {
            pageSourceId,
            event,
            targetType: target.type,
            targetSlug: target.slug,
            evidenceSlug,
            outcome: 'applied',
            matchedBy: target.matchedBy,
            details: {
              state_objects: objects.pages,
              ambiguous_state_objects: objects.ambiguous,
              supersedes: previousHash,
            },
          });
          return objects;
        });
        effects.state_objects = [...(effects.state_objects as string[]), ...stateObjects.pages];
        if (stateObjects.ambiguous.length > 0) {
          effects.ambiguous_state_objects = [
            ...(Array.isArray(effects.ambiguous_state_objects) ? effects.ambiguous_state_objects : []),
            ...stateObjects.ambiguous,
          ];
        }
      } catch (error) {
        await recordReceipt(engine, {
          pageSourceId,
          event,
          targetType: target.type,
          targetSlug: target.slug,
          evidenceSlug,
          outcome: 'failed',
          matchedBy: target.matchedBy,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    return { outcome: 'applied', targets: resolved.targets.map(t => t.slug), effects };
  };
}
