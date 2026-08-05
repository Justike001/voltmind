import type { BrainEngine } from '../engine.ts';
import { computeContentHash, type SourceEvidenceType, type TrackingReference } from '../ingestion/types.ts';
import type { Page } from '../types.ts';
import { resolveSourceEvidenceDirectory } from '../source-routing.ts';
import { computeFileRefsProjectionHash } from '../tracking-hashes.ts';
import { normalizeExternalFileRefs } from '../external-file-refs.ts';

const EVIDENCE_TYPES: readonly SourceEvidenceType[] = [
  'teams_thread',
  'meeting_transcript',
  'email',
  'calendar_event',
  'other',
];

const PAGE_TYPE_BY_EVIDENCE: Readonly<Record<SourceEvidenceType, string>> = {
  teams_thread: 'source_teams',
  meeting_transcript: 'source_meeting',
  email: 'source_email',
  calendar_event: 'source_calendar',
  other: 'source',
};

interface ReceiptMatch {
  outcome: string;
  event_version: string | null;
  content_hash: string | null;
  source_payload_hash: string | null;
  render_hash: string | null;
}

export interface TrackingEvidenceSweepResult {
  scanned: number;
  eligible: number;
  already_registered: number;
  already_pending: number;
  unregistered: number;
  missing_identity: number;
  inserted_receipts: number;
}

function stringField(frontmatter: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = frontmatter[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function evidenceTypeForPage(page: Page, expected: SourceEvidenceType): SourceEvidenceType | null {
  const explicit = page.frontmatter?.evidence_type;
  if (typeof explicit === 'string' && EVIDENCE_TYPES.includes(explicit as SourceEvidenceType)) {
    if (expected === 'other') return explicit === 'other' ? 'other' : null;
    return explicit === expected ? expected : null;
  }
  return page.type === PAGE_TYPE_BY_EVIDENCE[expected] ? expected : null;
}

function trackingRefs(frontmatter: Record<string, unknown>): TrackingReference[] {
  if (!Array.isArray(frontmatter.tracking_refs)) return [];
  return frontmatter.tracking_refs.filter((ref): ref is TrackingReference => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return false;
    const value = ref as Record<string, unknown>;
    return typeof value.provider === 'string' && value.provider.trim().length > 0
      && typeof value.resource === 'string' && value.resource.trim().length > 0
      && typeof value.id === 'string' && value.id.trim().length > 0;
  });
}

function pageHash(page: Page): string {
  return page.content_hash ?? computeContentHash(`${page.compiled_truth}\n\n${page.timeline}`);
}

function pageSourcePayloadHash(page: Page): string | null {
  return page.source_payload_hash ?? null;
}

function pageFileRefsHash(page: Page): string | null {
  if (page.file_refs_projection_hash) return page.file_refs_projection_hash;
  if (!Array.isArray(page.frontmatter.file_refs)) return null;
  try { return computeFileRefsProjectionHash(normalizeExternalFileRefs(page.frontmatter.file_refs)); } catch { return null; }
}

async function findReceipt(
  engine: BrainEngine,
  sourceId: string,
  evidenceSlug: string,
  eventId: string,
): Promise<ReceiptMatch | null> {
  const rows = await engine.executeRaw<ReceiptMatch>(
    `SELECT outcome,event_version,content_hash,source_payload_hash,render_hash
       FROM project_tracking_receipts
      WHERE page_source_id=$1 AND event_source_id=$1 AND target_type='evidence'
        AND evidence_slug=$2 AND event_key=$3
      ORDER BY updated_at DESC LIMIT 1`,
    [sourceId, evidenceSlug, eventId],
  );
  return rows[0] ?? null;
}

/**
 * Deterministically discover canonical evidence pages that have no matching
 * source-scoped receipt. This is a safety net for the client crash window
 * between put_page and register_tracking_evidence; it never interprets the
 * transcript or writes project/workstream pages.
 */
export async function sweepUnregisteredTrackingEvidence(
  engine: BrainEngine,
  opts: { sourceId: string; maxPages?: number; dryRun?: boolean },
): Promise<TrackingEvidenceSweepResult> {
  const limit = Math.max(1, Math.min(opts.maxPages ?? 10, 100));
  const result: TrackingEvidenceSweepResult = {
    scanned: 0,
    eligible: 0,
    already_registered: 0,
    already_pending: 0,
    unregistered: 0,
    missing_identity: 0,
    inserted_receipts: 0,
  };
  const seen = new Set<string>();

  for (const evidenceType of EVIDENCE_TYPES) {
    if (result.scanned >= limit) break;
    const directory = await resolveSourceEvidenceDirectory(evidenceType, opts.sourceId);
    if (!directory) continue;
    const pages = await engine.listPages({
      sourceId: opts.sourceId,
      slugPrefix: directory,
      sort: 'updated_desc',
      limit: limit - result.scanned,
    });
    for (const page of pages) {
      if (result.scanned >= limit) break;
      if (seen.has(page.slug)) continue;
      seen.add(page.slug);
      result.scanned++;

      const actualType = evidenceTypeForPage(page, evidenceType);
      if (!actualType) continue;
      if (actualType === 'other' && page.type !== 'source' && page.frontmatter?.evidence_type !== 'other') continue;
      result.eligible++;

      const eventId = stringField(page.frontmatter, 'event_id', 'tracking_event_id', 'source_event_id');
      const eventVersion = stringField(page.frontmatter, 'event_version', 'tracking_event_version');
      if (!eventId) {
        result.missing_identity++;
        continue;
      }

      const existing = await findReceipt(engine, opts.sourceId, page.slug, eventId);
      if (existing) {
        if (existing.outcome === 'registered' || existing.outcome === 'verified') result.already_registered++;
        else result.already_pending++;
        continue;
      }

      result.unregistered++;
      if (opts.dryRun) continue;

      const details = JSON.stringify({
        evidence_type: actualType,
        tracking_refs: trackingRefs(page.frontmatter),
        client_outcome: 'review_needed',
        affected_pages: [],
        audit_reason: 'registration_missing',
        discovered_by: 'tracking_maintenance',
      });
      await engine.executeRaw(
        `INSERT INTO project_tracking_receipts
          (page_source_id,event_source_id,event_kind,event_key,target_type,target_slug,event_version,content_hash,source_payload_hash,render_hash,file_refs_projection_hash,evidence_slug,outcome,matched_by,details,updated_at)
         VALUES ($1,$1,$2,$3,'evidence',$4,$5,$6,$7,$6,$8,$4,'pending','evidence_sweep',$9::text::jsonb,now())
         ON CONFLICT (page_source_id,event_source_id,event_kind,event_key,target_type,target_slug) DO NOTHING`,
        [opts.sourceId, actualType, eventId, page.slug, eventVersion, pageHash(page), pageSourcePayloadHash(page), pageFileRefsHash(page), details],
      );
      await engine.executeRaw(
        `INSERT INTO project_tracking_receipt_history
          (page_source_id,event_source_id,event_kind,event_key,target_type,target_slug,event_version,content_hash,source_payload_hash,render_hash,file_refs_projection_hash,snapshot_kind,evidence_slug,outcome,matched_by,details)
         VALUES ($1,$1,$2,$3,'evidence',$4,$5,$6,$7,$6,$8,'source_ingest',$4,'pending','evidence_sweep',$9::text::jsonb)
         ON CONFLICT (page_source_id,event_source_id,event_kind,event_key,target_type,target_slug,content_hash) DO NOTHING`,
        [opts.sourceId, actualType, eventId, page.slug, eventVersion, pageHash(page), pageSourcePayloadHash(page), pageFileRefsHash(page), details],
      );
      result.inserted_receipts++;
    }
  }
  return result;
}
