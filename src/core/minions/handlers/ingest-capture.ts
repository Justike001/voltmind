/**
 * `ingest_capture` Minion job handler. Receives an IngestionEvent payload
 * from the daemon's dispatcher (or the webhook source's POST /ingest
 * handler) and routes it through `importFromContent` to land as a brain
 * page.
 *
 * Trust posture (E1 + eng-review decisions):
 *   - The event's `untrusted_payload` flag is preserved on the job's
 *     result for audit, but does NOT change the importFromContent call
 *     itself — auto-link runs at the put_page operation layer, which we
 *     deliberately bypass here. The handler calls importFromContent
 *     directly. v1 path: webhook OAuth gate is the trust boundary; the
 *     handler trusts the event-shape but treats content as user-authored
 *     markdown.
 *   - Auto-link integration with the untrusted_payload tag is a v2
 *     improvement (would require routing through the put_page op AND
 *     extending OperationContext with the trust tag). See TODOs in the
 *     plan.
 *
 * Slug resolution (in order):
 *   1. `job.data.slug` if caller provided one
 *   2. `job.data.metadata.slug` if event metadata carried one
 *   3. Generated default: `inbox/YYYY-MM-DD-<hash6>` using the event's
 *      content_hash prefix. Stable for the same content.
 *
 * The default slug deliberately lives under `inbox/` — that's the
 * triage convention the user will discover when reviewing recent
 * captures. A downstream skill (post-capture-triage) can promote inbox
 * pages to canonical homes later.
 */

import type { MinionJobContext } from '../types.ts';
import type { BrainEngine } from '../../engine.ts';
import type { IngestionEvent } from '../../ingestion/types.ts';
import { validateIngestionEvent } from '../../ingestion/types.ts';
import { importFromContent } from '../../import-file.ts';
import { makeReceiptProjection, RECEIPT_SCHEMA_VERSION, type ReceiptProjection } from '../../receipts.ts';

export interface IngestCaptureQueue {
  add(
    name: string,
    data?: Record<string, unknown>,
    opts?: Record<string, unknown>,
    trusted?: { allowProtectedSubmit?: boolean },
  ): Promise<{ id: number }>;
}

export interface IngestCaptureResult {
  slug: string;
  status: 'imported' | 'skipped' | 'error';
  chunks: number;
  untrusted_payload: boolean;
  source_kind: string;
  source_uri: string;
  /** Deprecated compatibility fields; ingest no longer fills these. */
  tracking_job_id?: number;
  tracking_error?: string;
  receipt_id: string;
  schema_version: typeof RECEIPT_SCHEMA_VERSION;
  receipt_status: ReceiptProjection['receipt_status'];
  owner_source_id: string | null;
  page_source_id: string | null;
  emitter_source_id: string | null;
}

/** Builds the default slug for an event when the caller didn't provide one. */
export function defaultSlugForEvent(event: IngestionEvent, now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hashPrefix = event.content_hash.slice(0, 6);
  return `inbox/${y}-${m}-${d}-${hashPrefix}`;
}

function eventVersionIsOlder(incoming: string, current: string): boolean {
  const incomingTime = Date.parse(incoming);
  const currentTime = Date.parse(current);
  if (Number.isFinite(incomingTime) && Number.isFinite(currentTime)) return incomingTime < currentTime;
  return incoming < current;
}

export function makeIngestCaptureHandler(engine: BrainEngine, _queue?: IngestCaptureQueue) {
  return async function ingestCaptureHandler(job: MinionJobContext): Promise<IngestCaptureResult> {
    const data = job.data as { event?: unknown; slug?: unknown };
    const event = data.event as IngestionEvent | undefined;
    if (!event) {
      throw new Error('ingest_capture: job.data.event is required');
    }
    const validationErr = validateIngestionEvent(event);
    if (validationErr) {
      throw new Error(`ingest_capture: invalid event payload: ${validationErr.message}`);
    }

    // Slug resolution.
    let slug: string;
    if (typeof data.slug === 'string' && data.slug.length > 0) {
      slug = data.slug;
    } else if (
      event.metadata &&
      typeof (event.metadata as Record<string, unknown>).slug === 'string'
    ) {
      slug = (event.metadata as Record<string, unknown>).slug as string;
    } else {
      slug = defaultSlugForEvent(event);
    }

    // Resolve the page source before idempotency handling. Unregistered source
    // emitters retain the legacy default evidence source, but never become a
    // project-tracking target. Client agents register their already-written
    // canonical evidence through register_tracking_evidence instead.
    const sourceRows = await engine.executeRaw<{ id: string }>(
      'SELECT id FROM sources WHERE id = $1 LIMIT 1',
      [event.source_id],
    );
    const pageSourceId = sourceRows.length > 0 ? event.source_id : 'default';
    if (event.event_id && event.event_version) {
      const state = await engine.executeRaw<{ event_version: string | null }>(
        `SELECT event_version FROM ingestion_event_state
          WHERE source_id = $1 AND source_kind = $2 AND event_id = $3`,
        [event.source_id, event.source_kind, event.event_id],
      );
      const currentVersion = state[0]?.event_version;
      if (currentVersion && (eventVersionIsOlder(event.event_version, currentVersion)
        || event.event_version === currentVersion)) {
        const receipt = makeReceiptProjection({
          jobId: job.id,
          status: 'completed',
          ownerSourceId: (data as { owner_source_id?: unknown }).owner_source_id,
          pageSourceId,
          emitterSourceId: (data as { emitter_source_id?: unknown }).emitter_source_id
            ?? (event.metadata as Record<string, unknown> | undefined)?.emitter_id,
          sourceUri: event.source_uri,
        });
        return {
          slug,
          status: 'skipped',
          chunks: 0,
          untrusted_payload: event.untrusted_payload === true,
          source_kind: event.source_kind,
          ...receipt,
          source_uri: event.source_uri,
        };
      }
    }

    // Untrusted-payload posture. For v1, the flag is propagated for audit
    // but not enforced at this layer (see file header). Future v2 wiring
    // through put_page will use this flag.
    const untrustedPayload = event.untrusted_payload === true;
    // source_id historically names the emitter instance. Only registered
    // brain sources may be used as pages.source_id; preserve the legacy
    // default source behavior for unregistered third-party emitters.
    // For text-typed events, content is the inline markdown/text. For
    // binary types (image/audio/video/pdf), content is a path-or-URI that
    // the content-type processor pipeline transforms. The v1 wave lands
    // the text path; processors arrive in subsequent commits.
    const isText =
      event.content_type === 'text/markdown' ||
      event.content_type === 'text/plain' ||
      event.content_type === 'text/html' ||
      event.content_type === 'application/json' ||
      event.content_type === 'unknown';

    if (!isText) {
      // Binary content without a processor would land as a path-string
      // page, which isn't useful. Surface as job-level error so the
      // operator sees the gap in `voltmind doctor` and can decide whether
      // to install the appropriate skillpack-distributed processor.
      throw new Error(
        `ingest_capture: content_type '${event.content_type}' requires a content-type ` +
          `processor that is not yet installed. Install a processor skillpack ` +
          `(e.g. voltmind-audio-transcribe, voltmind-image-ocr) or pre-extract the ` +
          `content to text/markdown before emitting.`,
      );
    }

    // noEmbed defaults to true. Mirrors the sync handler's pattern:
    // embed runs as a separate Minion job (autopilot's embed phase OR an
    // explicit `voltmind embed --stale`). Callers can opt in to inline embed
    // by passing { noEmbed: false } in job.data.
    const noEmbed = (data as { noEmbed?: unknown }).noEmbed !== false;

    const pageMetadata = {
      ...(event.page_metadata ?? {}),
      ...(event.tracking_refs ? { tracking_refs: event.tracking_refs } : {}),
      ...(event.evidence_type ? { evidence_type: event.evidence_type } : {}),
      ...(event.event_id ? { tracking_event_id: event.event_id } : {}),
      ...(event.event_version ? { tracking_event_version: event.event_version } : {}),
    };

    const result = await importFromContent(engine, slug, event.content, {
      noEmbed,
      sourceId: pageSourceId,
      source_kind: event.source_kind,
      source_uri: event.source_uri,
      ingested_via: event.source_kind,
      externalFileRefs: event.file_refs,
      ...(Object.keys(pageMetadata).length > 0 ? { pageMetadata } : {}),
      ...(event.event_id ? {
        ingestionEventState: {
          sourceId: event.source_id,
          sourceKind: event.source_kind,
          eventId: event.event_id,
          eventVersion: event.event_version,
          jobId: job.id,
          contentHash: event.content_hash,
          sourcePayloadHash: event.source_payload_hash,
          fileRefsProjectionHash: event.file_refs_projection_hash,
        },
      } : {}),
      ...(event.source_payload_hash ? { sourcePayloadHash: event.source_payload_hash } : {}),
      ...(event.file_refs_projection_hash ? { fileRefsProjectionHash: event.file_refs_projection_hash } : {}),
      snapshotKind: 'source_ingest',
    });

    // Server-side raw-ingest compatibility: make the durable evidence visible
    // to Dream without interpreting it. Client-authored pages use the narrow
    // register_tracking_evidence operation instead, which upgrades this
    // pending receipt to registered/verified and records affected pages.
    // Tracking identity is evidence_type; source_kind remains provenance only.
    if (result.status === 'imported' && pageSourceId === event.source_id && event.event_id && event.evidence_type) {
      const trackingPage = await engine.getPage(slug, { sourceId: pageSourceId });
      const trackingRenderHash = trackingPage?.content_hash ?? event.content_hash;
      const trackingSourcePayloadHash = event.source_payload_hash ?? null;
      const trackingFileRefsProjectionHash = event.file_refs_projection_hash ?? trackingPage?.file_refs_projection_hash ?? null;
      const details = JSON.stringify({
        tracking_refs: event.tracking_refs ?? [],
        evidence_type: event.evidence_type,
        source_kind: event.source_kind,
        hash_scheme: event.hash_scheme ?? (event.source_payload_hash ? 'v2' : 'legacy'),
        raw_ingest: true,
      });
      await engine.executeRaw(
        `INSERT INTO project_tracking_receipts
          (page_source_id,event_source_id,event_kind,event_key,target_type,target_slug,event_version,content_hash,source_payload_hash,render_hash,file_refs_projection_hash,evidence_slug,outcome,matched_by,details,updated_at)
         VALUES ($1,$2,$3,$4,'evidence',$5,$6,$7,$8,$9,$10,$5,'pending','raw_ingest',$11::text::jsonb,now())
         ON CONFLICT (page_source_id,event_source_id,event_kind,event_key,target_type,target_slug)
         DO UPDATE SET event_version=EXCLUDED.event_version, content_hash=EXCLUDED.content_hash,
           source_payload_hash=EXCLUDED.source_payload_hash, render_hash=EXCLUDED.render_hash,
           file_refs_projection_hash=EXCLUDED.file_refs_projection_hash,
           evidence_slug=EXCLUDED.evidence_slug, details=EXCLUDED.details, updated_at=now()
           WHERE project_tracking_receipts.outcome NOT IN ('registered','verified')
             AND (project_tracking_receipts.event_version IS DISTINCT FROM EXCLUDED.event_version
               OR (project_tracking_receipts.source_payload_hash IS NOT NULL
                   AND project_tracking_receipts.source_payload_hash = EXCLUDED.source_payload_hash)
               OR (project_tracking_receipts.source_payload_hash IS NULL
                   AND EXCLUDED.source_payload_hash IS NULL
                   AND project_tracking_receipts.content_hash = EXCLUDED.content_hash))`,
        [pageSourceId, event.source_id, event.evidence_type ?? event.source_kind, event.event_id, slug,
          event.event_version ?? null, trackingRenderHash, trackingSourcePayloadHash, trackingRenderHash,
          trackingFileRefsProjectionHash, details],
      );
    }

    const receipt = makeReceiptProjection({
      jobId: job.id,
      status: 'completed',
      ownerSourceId: (data as { owner_source_id?: unknown }).owner_source_id,
      pageSourceId,
      emitterSourceId: (data as { emitter_source_id?: unknown }).emitter_source_id
        ?? (event.metadata as Record<string, unknown> | undefined)?.emitter_id,
      sourceUri: event.source_uri,
    });
    return {
      slug,
      status: result.status,
      chunks: result.chunks,
      untrusted_payload: untrustedPayload,
      source_kind: event.source_kind,
      ...receipt,
      source_uri: event.source_uri,
    };
  };
}
