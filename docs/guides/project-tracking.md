# Long-running project tracking

Client-authored project tracking is the hot path; company-server Dream is the
audit/repair workflow:

```text
Windows client / connector
  -> local canonical source Markdown
  -> Brain-First Lookup + local project/workstream/state or review candidate
  -> local validation + manifest update
  -> remote put_page canonical source evidence
  -> remote put_page project/workstream/state pages
  -> register_tracking_evidence (hash/version/actual affected pages)
  -> company-server Dream sweeps evidence pages, audits receipts, and repairs anomalies
```

Client `ingest` and `meeting-ingestion` retain their ordinary `put_page` and
Timeline capabilities and may write bound projects/workstreams/state pages. A
local Markdown write remains authoritative if remote synchronization fails:
record `local_written_remote_pending` and retry idempotently from the file.
The server never reparses the transcript on ingest.

## Server requirement

Use Postgres and run exactly one of these company-server arrangements:

```bash
VOLTMIND_RUNTIME_ROLE=company-server voltmind autopilot
```

or:

```bash
voltmind jobs work --runtime-role company-server
```

`company-server` autopilot runs the `tracking_maintenance` phase by default.
It first performs a source-scoped deterministic sweep of canonical
`sources/teams/`, `sources/meetings/`, `sources/emails/`, and
`sources/calendar/` pages. If a page has stable event identity in Frontmatter
but no matching receipt, it records a pending `registration_missing` audit
receipt. It then verifies complete receipts without LLM calls and submits only
anomalous records to the existing generic subagent. The phase is skipped on
thin clients.

Canonical evidence Frontmatter must retain `event_id` (or
`tracking_event_id`), `event_version` (or `tracking_event_version`),
`evidence_type`, and `tracking_refs`. The sweep uses these fields and the page
content hash only; it never classifies transcript text or copies Markdown.

The legacy `project_track_progress` handler remains only to drain old jobs and
never writes project pages. `tracking_maintenance` is protected, source-scoped,
and cannot be submitted by remote callers.

## Client registration

After the client-first `voltmind put` calls have synchronized the evidence and
the actual project/workstream/state pages, the client must complete the
registration step. Agents with the Host MCP tool call
`register_tracking_evidence` directly. Agents that only have a thin-client shell
can use the equivalent routed command:

```bash
voltmind register-tracking-evidence \
  --evidence-slug <sources/teams/...> \
  --event-id <provider-event-id> \
  --event-version <provider-version-or-etag> \
  --evidence-type teams_thread \
  --client-outcome applied \
  --tracking-refs '[{"provider":"teams","resource":"conversation","id":"<conversation-id>"}]' \
  --affected-pages '["projects/<project-slug>"]'
```

On a thin client this command uses the configured remote MCP and does not need a
local `database_url`. `voltmind call` is a local database dispatcher and is not
the thin-client registration path. If the routed command or MCP tool is absent,
the Host must be rebuilt/restarted and the source-bound OAuth client must have
`write` (or `admin`) scope. Keep the local ingest manifest pending until that
is fixed; the server evidence sweep remains the fallback.

## Source boundary

Tracking is source-scoped. `register_tracking_evidence` derives source scope
from the OAuth-bound operation context, validates the evidence page and active
schema-pack source directory, and never accepts a client `source_id`.

The first release only resolves project/workstream bindings in the same source
as the evidence page. If company evidence and canonical project pages are in
different sources, configure the connector to ingest into the canonical company
source until an explicit server-owned source mapping is introduced.

## Operations

Always name the source:

```bash
voltmind projects tracking status --source-id <company-source>
VOLTMIND_RUNTIME_ROLE=company-server \
  voltmind projects tracking reconcile --source-id <company-source>
```

Reconcile requests a source-scoped Dream maintenance pass with revision-aware
idempotency. It does not add/remove Frontmatter bindings; direct creation by
the client or Dream repair is allowed only when the project/workstream
definition is explicit and unambiguous. A client registration remains the
normal fast path; the evidence sweep is the reliability fallback for crashes or
network failures between the page write and registration.
