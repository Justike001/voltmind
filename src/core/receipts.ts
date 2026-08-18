import { createHash } from 'node:crypto';

export const RECEIPT_SCHEMA_VERSION = 1 as const;

export type ReceiptStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ReceiptProjection {
  receipt_id: string;
  schema_version: typeof RECEIPT_SCHEMA_VERSION;
  receipt_status: ReceiptStatus;
  job_id: number;
  owner_source_id: string | null;
  page_source_id: string | null;
  emitter_source_id: string | null;
  source_uri: string | null;
}

function sourceText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Stable across retries and idempotent re-submissions of the same job row. */
export function receiptIdForJob(jobId: number): string {
  return `rcpt_job_${jobId}`;
}

/** Stable identity for a non-queue final sync result. */
export function receiptIdForSync(sourceId: string | null | undefined, toCommit: string): string {
  const digest = createHash('sha256').update(`${sourceId ?? ''}:${toCommit}`).digest('hex').slice(0, 24);
  return `rcpt_sync_${digest}`;
}

export function receiptIdForTracking(sourceId: string, eventKind: string, eventId: string, targetSlug: string): string {
  const digest = createHash("sha256").update(sourceId + ":" + eventKind + ":" + eventId + ":" + targetSlug).digest("hex").slice(0, 24);
  return "rcpt_tracking_" + digest;
}

export function receiptStatusForTracking(outcome: string): ReceiptStatus {
  if (["registered", "verified", "duplicate", "reconciled", "complete"].includes(outcome)) return "completed";
  if (["pending", "candidate", "repairing"].includes(outcome)) return "running";
  if (["cancelled"].includes(outcome)) return "cancelled";
  return "failed";
}

export function makeTrackingReceiptProjection(input: {
  pageSourceId: string;
  ownerSourceId?: unknown;
  emitterSourceId?: unknown;
  sourceUri?: unknown;
  eventKind: string;
  eventId: string;
  targetSlug: string;
  outcome: string;
}): Record<string, unknown> {
  return {
    receipt_id: receiptIdForTracking(input.pageSourceId, input.eventKind, input.eventId, input.targetSlug),
    schema_version: RECEIPT_SCHEMA_VERSION,
    receipt_status: receiptStatusForTracking(input.outcome),
    // These are deliberately separate projections. The page source is the
    // source owning the persisted evidence row; owner/emitter are only filled
    // when the caller has authenticated knowledge of those identities.
    owner_source_id: sourceText(input.ownerSourceId),
    page_source_id: sourceText(input.pageSourceId),
    emitter_source_id: sourceText(input.emitterSourceId),
    source_uri: sourceText(input.sourceUri),
    event_id: input.eventId,
    event_kind: input.eventKind,
    target_slug: input.targetSlug,
  };
}

export function receiptStatusForJob(status: string): ReceiptStatus {
  if (status === 'active') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'dead') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return 'queued';
}

export function makeReceiptProjection(input: {
  jobId: number;
  status?: string;
  ownerSourceId?: unknown;
  pageSourceId?: unknown;
  emitterSourceId?: unknown;
  sourceUri?: unknown;
}): ReceiptProjection {
  return {
    receipt_id: receiptIdForJob(input.jobId),
    schema_version: RECEIPT_SCHEMA_VERSION,
    receipt_status: receiptStatusForJob(input.status ?? 'waiting'),
    job_id: input.jobId,
    owner_source_id: sourceText(input.ownerSourceId),
    page_source_id: sourceText(input.pageSourceId),
    emitter_source_id: sourceText(input.emitterSourceId),
    source_uri: sourceText(input.sourceUri),
  };
}

export function receiptFromJob(job: {
  id: number;
  status: string;
  source_id?: string | null;
  data?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
}): ReceiptProjection {
  const data = job.data ?? {};
  const event = data.event && typeof data.event === 'object' ? data.event as Record<string, unknown> : {};
  const result = job.result ?? {};
  const field = (snake: string, camel: string): unknown => {
    if (Object.prototype.hasOwnProperty.call(result, snake)) return result[snake];
    if (Object.prototype.hasOwnProperty.call(result, camel)) return result[camel];
    if (Object.prototype.hasOwnProperty.call(data, snake)) return data[snake];
    return data[camel];
  };
  const emitterSourceId = field('emitter_source_id', 'emitterSourceId');
  const sourceUri = field('source_uri', 'sourceUri');
  return makeReceiptProjection({
    jobId: job.id,
    status: job.status,
    // Do not fall back to the legacy minion_jobs.source_id column: its
    // historical meaning is not stable enough to be owner or page provenance.
    // Pending jobs expose null until the worker writes an explicit projection;
    // completed jobs expose the worker result first.
    ownerSourceId: field('owner_source_id', 'ownerSourceId'),
    pageSourceId: field('page_source_id', 'pageSourceId'),
    emitterSourceId: emitterSourceId === undefined
      ? (event.metadata as Record<string, unknown> | undefined)?.emitter_id
      : emitterSourceId,
    sourceUri: sourceUri === undefined ? event.source_uri : sourceUri,
  });
}

export function receiptFieldsForJob(job: {
  id: number;
  status: string;
  source_id?: string | null;
  data?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return receiptFromJob(job) as unknown as Record<string, unknown>;
}
