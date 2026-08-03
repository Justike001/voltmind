/**
 * Compatibility drain for pre-client-tracking jobs.
 *
 * Client agents now interpret evidence and write project/workstream/state
 * pages directly. This handler intentionally never parses Markdown or writes
 * those pages. Old queued jobs are acknowledged and, when possible, recorded
 * as a review-needed evidence receipt so they cannot resurrect the removed
 * server-side semantic merge path.
 */
import type { BrainEngine } from '../../engine.ts';
import type { IngestionEvent } from '../../ingestion/types.ts';
import type { MinionJobContext } from '../types.ts';
import { registerTrackingEvidence } from '../../project-tracking-runtime.ts';

interface LegacyTrackJobData {
  event?: IngestionEvent;
  evidence_slug?: string;
  page_source_id?: string;
}

export function makeProjectTrackProgressHandler(engine: BrainEngine) {
  return async function projectTrackProgressCompatibilityHandler(job: MinionJobContext): Promise<Record<string, unknown>> {
    const data = (job.data ?? {}) as LegacyTrackJobData;
    const event = data.event;
    if (!event) return { outcome: 'deprecated', review_needed: true, reason: 'missing_event' };
    const sourceId = data.page_source_id ?? event.source_id;
    if (event.event_id && event.evidence_type && data.evidence_slug) {
      try {
        const receipt = await registerTrackingEvidence(engine, sourceId, {
          evidence_slug: data.evidence_slug,
          event_id: event.event_id,
          event_version: event.event_version,
          evidence_type: event.evidence_type,
          tracking_refs: event.tracking_refs,
          client_outcome: 'review_needed',
          affected_pages: [],
        });
        return { outcome: 'deprecated', review_needed: true, receipt };
      } catch (error) {
        return {
          outcome: 'deprecated',
          review_needed: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { outcome: 'deprecated', review_needed: true, reason: 'legacy_job_without_canonical_evidence_identity' };
  };
}
