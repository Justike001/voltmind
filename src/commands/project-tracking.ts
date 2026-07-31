import type { BrainEngine } from '../core/engine.ts';
import { MinionQueue } from '../core/minions/queue.ts';
import { computeContentHash } from '../core/ingestion/types.ts';
import type { SourceEvidenceType, TrackingReference } from '../core/ingestion/types.ts';

function parseSource(args: string[]): string | undefined {
  const idx = args.indexOf('--source-id');
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}

export async function runProjectTracking(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0] ?? 'status';
  const sourceId = parseSource(args);
  if (sub === '--help' || sub === '-h') {
    console.log(
      'voltmind projects tracking status --source-id ID\n' +
      'VOLTMIND_RUNTIME_ROLE=company-server voltmind projects tracking reconcile --source-id ID\n',
    );
    return;
  }
  if (sub !== 'status' && sub !== 'reconcile') {
    throw new Error(`Unknown projects tracking command '${sub}'. Expected status or reconcile.`);
  }
  if (!sourceId) {
    throw new Error('projects tracking requires an explicit --source-id; default source fallback is forbidden');
  }
  const sourceRows = await engine.executeRaw<{ id: string }>(
    'SELECT id FROM sources WHERE id=$1 LIMIT 1',
    [sourceId],
  );
  if (sourceRows.length === 0) throw new Error(`Unknown source '${sourceId}'`);
  if (sub === 'status') {
    const rows = await engine.executeRaw<Record<string, unknown>>(
      `SELECT outcome, count(*)::int AS count
       FROM project_tracking_receipts WHERE page_source_id=$1 GROUP BY outcome ORDER BY outcome`,
      [sourceId],
    );
    const candidates = await engine.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM project_tracking_receipts
       WHERE page_source_id=$1 AND outcome IN ('candidate','failed')`, [sourceId],
    );
    const jobs = await engine.executeRaw<Record<string, unknown>>(
      `SELECT status, count(*)::int AS count
       FROM minion_jobs WHERE name='project_track_progress'
       GROUP BY status ORDER BY status`,
    );
    const latest = await engine.executeRaw<{ last_receipt_at: string | null }>(
      `SELECT max(updated_at)::text AS last_receipt_at
       FROM project_tracking_receipts WHERE page_source_id=$1`,
      [sourceId],
    );
    console.log(JSON.stringify({
      source_id: sourceId,
      runtime_role: process.env.VOLTMIND_RUNTIME_ROLE ?? 'client',
      by_outcome: rows,
      pending_review_or_failed: candidates[0]?.count ?? 0,
      tracking_jobs: jobs,
      last_receipt_at: latest[0]?.last_receipt_at ?? null,
    }, null, 2));
    return;
  }

  if (process.env.VOLTMIND_RUNTIME_ROLE !== 'company-server') {
    throw new Error(
      'projects tracking reconcile is server-only; set VOLTMIND_RUNTIME_ROLE=company-server on the company-brain host',
    );
  }
  if (engine.kind !== 'postgres') {
    throw new Error('projects tracking reconcile requires the company-brain Postgres engine');
  }

  const queue = new MinionQueue(engine);
  const pages = await engine.listPages({ sourceId, sort: 'updated_asc' });
  let submitted = 0;
  for (const page of pages) {
    const refs = page.frontmatter?.tracking_refs;
    if (!Array.isArray(refs)) continue;
    const eventId = typeof page.frontmatter?.tracking_event_id === 'string'
      ? page.frontmatter.tracking_event_id
      : undefined;
    const content = `${page.compiled_truth}\n\n${page.timeline}`;
    const contentHash = page.content_hash ?? computeContentHash(content);
    const event = {
      source_id: sourceId,
      source_kind: page.source_kind ?? 'reconcile',
      source_uri: page.source_uri ?? page.slug,
      received_at: page.updated_at.toISOString(),
      content_type: 'text/markdown' as const,
      content,
      content_hash: contentHash,
      ...(eventId ? { event_id: eventId } : {}),
      ...(typeof page.frontmatter?.tracking_event_version === 'string' ? { event_version: page.frontmatter.tracking_event_version } : {}),
      tracking_refs: refs as TrackingReference[],
      ...(typeof page.frontmatter?.evidence_type === 'string'
        ? { evidence_type: page.frontmatter.evidence_type as SourceEvidenceType }
        : {}),
    };
    await queue.add('project_track_progress', { event, evidence_slug: page.slug, page_source_id: sourceId }, {
      idempotency_key: `project-track-reconcile:${sourceId}:${page.slug}:${contentHash}`,
    }, { allowProtectedSubmit: true });
    submitted++;
  }
  console.log(JSON.stringify({ source_id: sourceId, submitted }, null, 2));
}
