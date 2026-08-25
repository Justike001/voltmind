### Client-first local write and remote synchronization (MANDATORY)

The existing server relay remains available for company-server raw-ingest
compatibility. A client-authored run follows this order:

1. Read the local-vault taxonomy preflight in
   [client-vault-taxonomy.md](client-vault-taxonomy.md) before selecting any
   new semantic page route. The active schema pack remains the machine
   authority; vault resolver/schema/index/README files provide local context.
2. Read Teams/Outlook evidence with the client connector and persist the raw
   source Markdown to the local vault.
3. Run Brain-First Lookup; write confirmed semantic pages locally and persist
   ambiguous project candidates or generic clarification candidates in their
   durable review indexes. Do not wait for human review to continue raw capture
   or unrelated semantic work.
4. For canonical semantic pages, invoke local
   `voltmind put <slug> < page.md`. The command validates the canonical draft
   before its atomic local-vault write. A validation failure means no semantic
   page was written locally or remotely.
5. Let that local command forward the exact persisted Markdown through remote
   `put_page`; do not call the Host MCP tool directly for client-first semantic
   writes. If remote synchronization fails after the local write, retain
   `local_written_remote_pending` and retry from the local file.
6. Call `register_tracking_evidence` only after the remote source write
   succeeds. Pass only actual project/workstream/state slugs in
   `affected_pages`; review-index-only evidence uses `review_needed` with
   an empty list. Include the preserved `action_assignments` intermediate for
   every action slug in `affected_pages`; omission is itself a deterministic
   review-required finding.

Do not use `submit_ingestion_event` for this client-authored path; that operation
remains company-server-only raw-ingest compatibility. The shared remote repo
does not change this ownership boundary: runtime role and client tool bindings
decide which path is allowed.

For Teams incremental reads, keep one checkpoint per `chat_id`, call
`chat_list_messages` once with `top=100` and
`sent_after = checkpoint - overlap`, and deduplicate by `message_id`. Do not
paginate or split historical time ranges: the connector exposes only its latest
100 messages. The checkpoint is a **high watermark**: the newest durably
captured message timestamp, never the oldest message in a batch. A result count
below 100 may advance it to `newest_returned_at` only after every event in the
batch has been registered. A result count at 100 remains `saturated`; after all
returned events are durable, record the unrecoverable older gap and advance the
incremental high watermark so later runs continue with new messages.
Do not claim a complete historical window or perform a one-shot 30-day backfill
for a high-volume chat while the connector exposes neither an upper time bound
nor a continuation/delta cursor.
