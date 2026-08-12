# Teams and Outlook Cold-start Windows

Read this reference for cold start, incremental history, checkpoints, bounded
windows, connector caps, saturation, or rate limits.

## Connector limits

- Prefer `top=50` or less for Teams history reads.
- The connector cap is 99 results.
- With only `sent_after`, a logical end time is not server-enforced and
  post-filtering cannot recover messages displaced by a newest-first cap.
- Deduplicate by `teams:<container_id>:<message_id>`.
- A checkpoint is the newest durably captured timestamp, never the oldest item
  returned.

If a result reaches the cap, mark the interval `saturated` and
`blocked_by_connector_pagination`; retain captured evidence but do not claim the
older interval is covered. Create historical child windows only when the
connector has a verified upper bound or continuation cursor. For ongoing feeds,
record the unrecoverable gap and advance a separate incremental high watermark
so future messages are still captured.

On HTTP 429, honor `Retry-After`; otherwise use bounded backoff of 30s, 60s,
120s, then 300s. Keep the container `rate_limited`/`blocked`, preserve prior
coverage, record the next retry time, and continue unrelated containers. Never
classify a rate-limited window as `no_signal`.

## Manifest contract

Create or resume one local Markdown manifest under `state/indexes/` before the
first connector read. Maintain one record per chat/channel and logical
`[start,end)` window with:

```yaml
container_kind: chat
container_id: stable-id
team_id: null
channel_id: null
window_start: 2026-07-01T00:00:00Z
window_end: 2026-07-02T00:00:00Z
acquisition_status: pending
semantic_status: pending
returned_count: 0
accepted_count: 0
saturated: false
oldest_returned_at: null
newest_returned_at: null
first_message_id: null
last_message_id: null
attempt_count: 0
last_attempt_at: null
retry_after: null
last_error: null
source_pages: []
next_action: read_window
updated_at: 2026-08-05T00:00:00Z
```

Allowed acquisition states are `pending`, `reading`, `captured`, `saturated`,
`rate_limited`, `blocked`, `failed`, and `interrupted`. Semantic states are
`pending`, `complete`, `no_signal`, `review_required`, and `skipped`.

## State transitions

1. Choose due rate-limited work, then captured semantic work, then the oldest
   pending window. Do not repeatedly call blocked windows.
2. Set `reading` and increment attempts immediately before the connector call.
3. Deduplicate and persist raw evidence before updating observed counts/bounds.
4. Set `captured` only when evidence is durable and the result is unsaturated.
5. Treat `reading` older than 20 minutes as `interrupted` and resume
   idempotently.
6. Mark a window complete only when the requested interval is covered, raw
   evidence is durable, semantic routing finished, and no saturation, retry, or
   write failure remains.

The manifest is operational state, not semantic truth and never replaces raw
evidence citations.
