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
  tracking_job_id?: number;
  tracking_error?: string;
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

export function makeIngestCaptureHandler(engine: BrainEngine, queue?: IngestCaptureQueue) {
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

    // Resolve the page source before idempotency handling. A same-version
    // delivery may be the retry that repairs a previously failed tracking
    // enqueue, so the skipped-import path must still submit tracking.
    const sourceRows = await engine.executeRaw<{ id: string }>(
      'SELECT id FROM sources WHERE id = $1 LIMIT 1',
      [event.source_id],
    );
    const pageSourceId = sourceRows.length > 0 ? event.source_id : 'default';
    const enqueueTracking = async (): Promise<{ id?: number; error?: string }> => {
      if (!queue) return {};
      try {
        const trackingJob = await queue.add('project_track_progress', {
          event,
          evidence_slug: slug,
          page_source_id: pageSourceId,
        }, {
          // Event revisions are distinct jobs. The receipt layer performs
          // target-level idempotency; this key only deduplicates an identical
          // delivery/retry.
          idempotency_key: [
            'project-track',
            event.source_id,
            event.source_kind,
            event.event_id ?? event.content_hash,
            event.event_version ?? 'unversioned',
          event.content_hash,
          ].join(':'),
        }, { allowProtectedSubmit: true });
        // A retry may be repairing a prior queue outage. Clear only the
        // dispatch-health receipt; target receipts are owned by the tracking
        // handler and remain untouched.
        try {
          await engine.executeRaw(
            `DELETE FROM project_tracking_receipts
             WHERE page_source_id=$1 AND event_source_id=$2 AND event_kind=$3
               AND event_key=$4 AND target_type='review'
               AND target_slug='state/indexes/project-tracking-dispatch-health'
               AND outcome='failed'`,
            [pageSourceId, event.source_id, event.source_kind, event.event_id?.trim() || event.content_hash],
          );
        } catch {
          // A stale dispatch-health row is preferable to reporting a
          // successfully queued job as failed.
        }
        return { id: trackingJob.id };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Raw evidence is already durable. Persist a source-scoped health
        // signal so maintenance can find the missing dispatch even if the
        // connector never retries; a later same-version replay clears it.
        try {
          const key = event.event_id?.trim() || event.content_hash;
          const details = JSON.stringify({
            dispatch_status: 'failed',
            tracking_refs: event.tracking_refs ?? [],
            evidence_type: event.evidence_type ?? null,
          });
          await engine.executeRaw(
            `INSERT INTO project_tracking_receipts
              (page_source_id, event_source_id, event_kind, event_key, target_type,
               target_slug, event_version, content_hash, evidence_slug, outcome,
               matched_by, details, last_error, updated_at)
             VALUES ($1,$2,$3,$4,'review',$5,$6,$7,$8,'failed','dispatch',
               $9::text::jsonb,$10,now())
             ON CONFLICT (
               page_source_id, event_source_id, event_kind, event_key,
               target_type, target_slug
             ) DO UPDATE SET event_version=EXCLUDED.event_version,
               content_hash=EXCLUDED.content_hash, evidence_slug=EXCLUDED.evidence_slug,
               outcome='failed', matched_by='dispatch', details=EXCLUDED.details,
               last_error=EXCLUDED.last_error, updated_at=now()`,
            [pageSourceId, event.source_id, event.source_kind, key,
              'state/indexes/project-tracking-dispatch-health',
              event.event_version ?? null, event.content_hash, slug, details, message],
          );
          await engine.executeRaw(
            `INSERT INTO project_tracking_receipt_history
              (page_source_id, event_source_id, event_kind, event_key, target_type,
               target_slug, event_version, content_hash, evidence_slug, outcome,
               matched_by, details, last_error)
             VALUES ($1,$2,$3,$4,'review',$5,$6,$7,$8,'failed','dispatch',
               $9::text::jsonb,$10)
             ON CONFLICT (
               page_source_id, event_source_id, event_kind, event_key,
               target_type, target_slug, content_hash
             ) DO NOTHING`,
            [pageSourceId, event.source_id, event.source_kind, key,
              'state/indexes/project-tracking-dispatch-health',
              event.event_version ?? null, event.content_hash, slug, details, message],
          );
        } catch {
          // The import result still reports tracking_error when DB health
          // recording itself is unavailable.
        }
        return { error: message };
      }
    };

    if (event.event_id && event.event_version) {
      const state = await engine.executeRaw<{ event_version: string | null }>(
        `SELECT event_version FROM ingestion_event_state
          WHERE source_id = $1 AND source_kind = $2 AND event_id = $3`,
        [event.source_id, event.source_kind, event.event_id],
      );
      const currentVersion = state[0]?.event_version;
      if (currentVersion && (eventVersionIsOlder(event.event_version, currentVersion)
        || event.event_version === currentVersion)) {
        const tracking = await enqueueTracking();
        return {
          slug,
          status: 'skipped',
          chunks: 0,
          untrusted_payload: event.untrusted_payload === true,
          source_kind: event.source_kind,
          source_uri: event.source_uri,
          ...(tracking.id !== undefined ? { tracking_job_id: tracking.id } : {}),
          ...(tracking.error ? { tracking_error: tracking.error } : {}),
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
        },
      } : {}),
    });

    let trackingJobId: number | undefined;
    let trackingError: string | undefined;
    if (queue && result.status === 'imported') {
      const tracking = await enqueueTracking();
      trackingJobId = tracking.id;
      trackingError = tracking.error;
    }

    return {
      slug,
      status: result.status,
      chunks: result.chunks,
      untrusted_payload: untrustedPayload,
      source_kind: event.source_kind,
      source_uri: event.source_uri,
      ...(trackingJobId !== undefined ? { tracking_job_id: trackingJobId } : {}),
      ...(trackingError ? { tracking_error: trackingError } : {}),
    };
  };
}
