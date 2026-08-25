### Teams chat recent-message reads

This is the authoritative rule for the Teams connector's
`chat_list_messages` operation. Chat reads use one latest-100 request without
time slicing or historical child windows. Channel-specific behavior and shared 429,
manifest, raw-evidence, and semantic-routing rules remain unchanged.

For each approved chat or group chat:

1. Call `chat_list_messages` once with `top=100` to obtain the connector's
   latest available messages. Do not lower `top` to manufacture time windows.
2. Do not paginate, split the requested time range, or issue child-window calls
   to recover older messages. This connector exposes only the latest 100 and
   cannot fetch backward beyond that result set.
3. Persist every returned raw message before semantic routing. Deduplicate by
   `teams:<chat_id>:<message_id>` and retain the oldest/newest returned
   timestamps in the local manifest.
4. When 100 messages are returned, mark acquisition `saturated`, record the
   older range as an `unrecoverable_gap`, and never claim historical coverage.
   After all 100 messages are durably written and registered, advance the
   incremental high watermark to the newest returned timestamp so the next run
   can ingest subsequently arriving messages instead of repeating the same
   batch.
5. When fewer than 100 messages are returned, advance the high watermark only
   after every returned event is durable and registered. The response covers
   only what the connector actually returned; do not infer older history.
6. A 429 retry repeats the same single recent-message read after the permitted
   backoff. It is not pagination and must not trigger historical slicing.

The 100-message limit is an acquisition boundary, not a semantic limit. Process
all captured messages through the normal signal filter, raw-evidence write,
confirmed relationship materialization, citations, timeline reconciliation,
and client-first synchronization.
