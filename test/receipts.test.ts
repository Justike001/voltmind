import { describe, expect, test } from 'bun:test';
import {
  RECEIPT_SCHEMA_VERSION,
  makeReceiptProjection,
  receiptFromJob,
  receiptIdForJob,
  receiptIdForSync,
  makeTrackingReceiptProjection,
  receiptIdForTracking,
  receiptStatusForTracking,
} from '../src/core/receipts.ts';

describe('receipt contract', () => {
  test('job receipts are stable and preserve explicit source projections', () => {
    const receipt = makeReceiptProjection({
      jobId: 42,
      status: 'waiting',
      ownerSourceId: 'owner-a',
      pageSourceId: 'page-b',
      emitterSourceId: 'emitter-c',
      sourceUri: 'github:owner-a/repo',
    });
    expect(receipt).toEqual({
      receipt_id: 'rcpt_job_42',
      schema_version: RECEIPT_SCHEMA_VERSION,
      receipt_status: 'queued',
      job_id: 42,
      owner_source_id: 'owner-a',
      page_source_id: 'page-b',
      emitter_source_id: 'emitter-c',
      source_uri: 'github:owner-a/repo',
    });
    expect(receiptIdForJob(42)).toBe('rcpt_job_42');
  });

  test('job status mapping is explicit and fail-closed to queued', () => {
    expect(receiptFromJob({ id: 1, status: 'active' }).receipt_status).toBe('running');
    expect(receiptFromJob({ id: 2, status: 'completed' }).receipt_status).toBe('completed');
    expect(receiptFromJob({ id: 3, status: 'failed' }).receipt_status).toBe('failed');
    expect(receiptFromJob({ id: 4, status: 'cancelled' }).receipt_status).toBe('cancelled');
    expect(receiptFromJob({ id: 5, status: 'unknown' }).receipt_status).toBe('queued');
  });

  test('legacy source_id is ignored unless explicit projections exist', () => {
    const receipt = receiptFromJob({
      id: 7,
      status: 'completed',
      source_id: 'owner-a',
      data: {
        owner_source_id: 'owner-a',
        page_source_id: 'page-b',
        emitter_source_id: 'emitter-c',
        source_uri: 'https://example.test/page',
      },
    });
    expect(receipt.owner_source_id).toBe('owner-a');
    expect(receipt.page_source_id).toBe('page-b');
    expect(receipt.emitter_source_id).toBe('emitter-c');
    expect(receipt.source_uri).toBe('https://example.test/page');

    const explicitNull = receiptFromJob({
      id: 8,
      status: 'completed',
      data: { owner_source_id: 'old-owner', page_source_id: 'old-page', source_uri: 'old-uri' },
      result: { owner_source_id: null, page_source_id: null, emitter_source_id: null, source_uri: null },
    });
    expect(explicitNull.owner_source_id).toBeNull();
    expect(explicitNull.page_source_id).toBeNull();
    expect(explicitNull.emitter_source_id).toBeNull();
    expect(explicitNull.source_uri).toBeNull();
  });

  test('sync receipt identity is deterministic', () => {
    expect(receiptIdForSync('source-a', 'abc')).toBe(receiptIdForSync('source-a', 'abc'));
    expect(receiptIdForSync('source-a', 'abc')).not.toBe(receiptIdForSync('source-b', 'abc'));
  });

  test("tracking and sync receipts expose stable source projections", () => {
    const tracking = makeTrackingReceiptProjection({ pageSourceId: "page-b", ownerSourceId: "owner-a", eventKind: "teams_thread", eventId: "event-1", targetSlug: "sources/teams/event-1", outcome: "registered" });
    expect(tracking.receipt_id).toBe(receiptIdForTracking("page-b", "teams_thread", "event-1", "sources/teams/event-1"));
    expect(tracking.schema_version).toBe(RECEIPT_SCHEMA_VERSION);
    expect(tracking.receipt_status).toBe("completed");
    expect(tracking.owner_source_id).toBe("owner-a");
    expect(tracking.page_source_id).toBe("page-b");
    expect(receiptStatusForTracking("review_needed")).toBe("failed");
    expect(receiptStatusForTracking("pending")).toBe("running");
  });
});
