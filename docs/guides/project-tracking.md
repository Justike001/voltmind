# Long-running project tracking

Client-authored project tracking is the hot path; company-server Dream is the
audit/repair workflow:

```text
Windows client / connector
  -> Brain-First Lookup + client LLM classification
  -> remote put_page canonical source evidence
  -> remote put_page project/workstream/state pages
  -> register_tracking_evidence (hash/version/affected pages)
  -> company-server Dream audits receipts and repairs anomalies
```

Client `ingest` and `meeting-ingestion` retain their ordinary `put_page` and
Timeline capabilities and may write bound projects/workstreams/state pages. A
local Markdown write is tracked when the client registers the already-written
canonical source evidence; the server never reparses the transcript on ingest.

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
It verifies complete receipts without LLM calls and submits only anomalous
records to the existing generic subagent. The phase is skipped on thin clients.

The legacy `project_track_progress` handler remains only to drain old jobs and
never writes project pages. `tracking_maintenance` is protected, source-scoped,
and cannot be submitted by remote callers.

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
definition is explicit and unambiguous.
