# Long-running project tracking

Automatic project tracking is a company-brain server workflow:

```text
Windows client / connector
  -> POST /ingest/events (tracking_refs + evidence_type)
  -> ingest_capture persists raw evidence
  -> project_track_progress job
  -> company-server worker updates bound project/workstream/state pages
```

Client `ingest` and `meeting-ingestion` skills may create evidence and ordinary
entity pages, but must not write `projects/`, `workstreams/`, or canonical
action/decision/commitment/risk pages. A local Markdown write followed by
`voltmind sync` is not a project-tracking trigger.

## Server requirement

Use Postgres and run exactly one of these server-side worker arrangements:

```bash
VOLTMIND_RUNTIME_ROLE=company-server voltmind autopilot
```

or:

```bash
voltmind jobs work --runtime-role company-server
```

`company-server` autopilot fails fast if Minions are disabled, the engine is
PGLite, or `--inline` / `--no-worker` prevents the managed worker from running.
The dream cycle is not the tracking executor.

Workers default to the `client` role and do not register
`project_track_progress`. The job name is protected, so remote `submit_job`
callers cannot manufacture tracking payloads.

## Source boundary

Tracking is source-scoped. The ingest handler passes the exact page source to
the tracking job, and the tracking handler rejects a missing or unregistered
`page_source_id`; it never falls back silently to `default`.

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

Reconcile replays durable evidence with revision-aware idempotency. It does not
add or remove Frontmatter bindings and does not create projects/workstreams.
