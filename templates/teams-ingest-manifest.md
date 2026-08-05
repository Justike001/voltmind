---
type: index
title: Teams ingest manifest — {date-range}
scope: private
visibility: private
sensitivity: internal
promotion: never
publish_level: never
status: active
source_refs: []
related_entities: []
---

# Teams ingest manifest — {date-range}

This page is the local client control plane for a long-running Teams cold-start
import. It records connector coverage and retry state; it is not semantic
knowledge and must not be used as a substitute for raw evidence pages.

## Run

- **Run ID:** `{run-id}`
- **Requested window:** `{window-start}` → `{window-end}`
- **Overlap:** `{overlap}`
- **Connector:** Microsoft Teams OAuth connector
- **Updated:** `{updated-at}`

## Containers

```yaml
- container_kind: chat
  container_id: <stable-chat-id>
  team_id:
  channel_id:
  window_start: 2026-07-01T00:00:00Z
  window_end: 2026-07-02T00:00:00Z
  last_successful_message_time:
  last_message_id:
  messages_read: 0
  status: pending
  saturated: false
  retry_count: 0
  retry_after:
  last_error:
  next_action: read_window
  updated_at: 2026-08-05T00:00:00Z
```

## Status rules

- `complete`: raw evidence durable, deduplicated, and window verified.
- `saturated`: result reached the connector cap; split the time window and do
  not advance the checkpoint.
- `rate_limited`: connector returned 429; honor backoff and keep the previous
  checkpoint.
- `blocked`: retry budget exhausted or access remains unavailable; do not call
  it `no_signal`.
- `partial`: some evidence was written, but the requested window is not yet
  complete.

## Evidence pages

- `{sources/teams/...}`

## Notes

- Every raw evidence page is written before its corresponding checkpoint moves.
- Every message is deduplicated by stable `message_id`.
- Semantic pages cite evidence pages; this manifest alone is never semantic
  evidence.
