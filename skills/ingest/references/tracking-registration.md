# Tracking, Clarification, and Receipt Registration

Read this reference for project/workstream progress, canonical state objects,
ambiguity, client/Host write-through, or receipt registration.

## Client-first write order

1. Persist canonical raw evidence locally with stable identity fields.
2. Run Brain-First Lookup over projects, workstreams, bindings, aliases,
   backlinks, and timelines.
3. Write confirmed semantic pages and review candidates locally.
4. Use local `voltmind put` to validate and atomically write the exact Markdown,
   then forward those bytes to remote `put_page`.
5. If remote sync fails, retain `local_written_remote_pending` and retry from
   the local file.
6. Call `register_tracking_evidence` only after remote evidence/semantic writes
   succeed.

Do not use `submit_ingestion_event` for client-authored semantic work. It is the
company-server raw-ingest compatibility path. Server Dream audits receipts and
repairs anomalies; it does not reinterpret all evidence on the ingest hot path.

## Target resolution

A unique binding may update an existing project/workstream. An unbound event may
create a project only when goal, owner, scope, status, and completion condition
are clear; otherwise use a workstream for a durable responsibility domain.
Multiple target candidates go to `state/indexes/project-tracking-review` without
blocking unrelated work.

Identity, fact, relationship, owner, time, privacy, or brain/source ambiguity
goes to `state/indexes/ingest-clarification-review`. Preserve the exact excerpt,
set `semantic_status: review_required`, reconcile against later evidence, and
use `ask-user` one question per turn. Ask immediately only when a wrong write
could merge/overwrite an entity, cross an ownership/privacy boundary, create an
actionable owner/deadline, or corrupt canonical state.

## Receipt contract

`register_tracking_evidence` receives stable event identity, evidence type,
tracking refs, actual `client_outcome`, actual `affected_pages`, and structured
`action_assignments` for each affected action.

- `affected_pages` contains only project/workstream/state pages actually
  changed or created.
- Review-index-only evidence uses `review_needed` with an empty list.
- A deterministic coverage failure stores findings and remains
  `semantic_status: review_required`.
- Same-version conflicts remain conflict/manual review rather than silently
  overwriting evidence.
- The same event revision may be re-registered after repair and becomes complete
  only after all gates pass.

The clarification index is operational metadata, not a semantic citation or an
affected page.
