### Teams bounded-window and rate-limit behavior (client connector)

The client Teams connector is an official OAuth-bound connector; the agent does
not modify its request schema or transport behavior. Skill rules therefore
control call shape, pacing, and completeness claims only.

- For `chat_list_messages`, request the latest batch once with `top=100`.
  Do not lower `top`, paginate, or split time ranges to recover older chat
  messages; the connector cannot fetch backward beyond its latest 100.
- Treat any chat time window as manifest bookkeeping only. It does not remove
  the need for `message_id` deduplication, raw-source persistence, and an honest
  coverage record.
- When the connector exposes only `sent_after`, post-filtering by an intended
  end time cannot recover messages displaced by a newest-first capped response.
  If the result is saturated, do not split and retry historical child windows:
  mark the logical range `blocked` with
  `last_error: blocked_by_connector_pagination`, retain the newest captured
  batch, and do not call the older history covered.
- On HTTP 429, do not immediately repeat the same call. Honor `Retry-After`
  when available; otherwise use bounded exponential backoff (30s, 60s, 120s,
  300s) with a maximum retry budget. Keep the affected chat/channel in a
  `rate_limited` or `blocked` state and do not classify it as `no_signal`.
- Rate-limit retries per chat/channel, keep unrelated chats progressing, and
  avoid concurrent history reads for high-volume channels. If the connector
  does not expose `Retry-After` or retry metadata, record the observed 429 and
  the next retry time in the ingest status/manifest rather than fabricating
  completion.
- For recurring ingest, persist a lightweight per-container manifest (whether
  in connector state or a local `state/indexes/` page) containing the window,
  checkpoint, returned count, saturation flag, retry count, and completion
  status. For a one-off bounded batch this can be one line per window; it need
  not become a semantic project page.

#### Local cold-start ingest manifest contract

For every Teams/Outlook cold-start run, create or resume one local Markdown
manifest under `state/indexes/` before the first connector read.
The manifest is the durable client-side control plane for both cold-start phase
progress and per-container ingestion; do not maintain a competing JSON cursor.
Write observed results only—never create a completion record from an assumption.

Use independent records for every chat/channel and time window `[start, end)`.
The run manifest frontmatter records the requested scope, connector capability
limits, and `phases_completed` / `next_phase`. Its ledger records the work
units. Use two statuses because raw capture and semantic routing are separate:

```yaml
container_kind: chat # chat | channel
container_id: <stable-chat-or-channel-id>
team_id: null # required for a channel
channel_id: null # required for a channel
window_start: 2026-07-01T00:00:00Z
window_end: 2026-07-02T00:00:00Z
acquisition_status: pending # pending | reading | captured | saturated | rate_limited | blocked | failed | interrupted
semantic_status: pending # pending | complete | no_signal | review_required | skipped
returned_count: 0
accepted_count: 0
saturated: false
oldest_returned_at: null
newest_returned_at: null
first_message_id: null # diagnostic only
last_message_id: null # diagnostic only
attempt_count: 0
last_attempt_at: null
retry_after: null
last_error: null
source_pages: []
next_action: read_window
updated_at: 2026-08-05T00:00:00Z
```

The canonical deduplication key is `teams:<container_id>:<message_id>`.
`first_message_id` and `last_message_id` help diagnose a window but do not
replace per-message deduplication. Preserve complete message identity in raw
evidence pages or the local index, not in the manifest.

State transitions are deliberately conservative:

1. Select the next eligible work unit from the manifest: due `rate_limited`,
   then `captured` with semantic work pending,
   then the oldest `pending` window. Do not repeatedly call `blocked` windows.
2. Set `acquisition_status: reading` and increment `attempt_count` immediately
   before a connector read.
3. Persist raw evidence first. Deduplicate by `message_id`, then write returned
   bounds/counts and source-page links into the manifest.
4. Set `captured` only when raw evidence is durable and the result is not
   saturated. Set `semantic_status` separately after routing has reached
   `complete`, `no_signal`, `review_required`, or `skipped`.
5. If the result returns 100 messages, retain the logical range as `saturated`
   and set `next_action: blocked_by_connector_pagination`. Do not create
   historical child windows or pagination attempts. For an ongoing incremental
   feed, record an explicit
   `unrecoverable_gap` from the prior high watermark to `oldest_returned_at`,
   then advance a separate `incremental_high_watermark` to
   `newest_returned_at` so future messages can still be captured. Never label
   the gap covered.
6. If the connector returns HTTP 429, set `rate_limited`, preserve the prior
   coverage, record `retry_after` / `last_error`, and set
   `next_action: retry_after_backoff`.
7. Treat `reading` records older than 20 minutes as `interrupted`; rerun them
   idempotently from raw evidence and message IDs.
8. Mark a window fully complete only when the requested interval is covered,
   raw evidence is durable, and no saturation, retry, or write failure remains.

The manifest is operational state, not semantic truth. Project, person, action,
decision, and risk pages must cite raw evidence pages and must not be created
merely because a manifest says a window was read.
