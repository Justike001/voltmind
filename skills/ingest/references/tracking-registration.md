# Client-authored tracking registration (MANDATORY)

This reference applies to every client-authored Teams, meeting, Outlook Email,
or Outlook Calendar ingest that writes canonical source evidence and any
project/workstream/state page.

## Ownership and order

The client agent owns semantic tracking during ingest. The registration step is
an audit hand-off, not a second semantic extraction pass:

1. Preserve the real connector evidence in the local vault first.
2. Run Brain-First Lookup and decide whether to update an existing
   project/workstream, create an explicitly-defined new one, or append a
   candidate to the appropriate review index.
3. Write the evidence page locally, then synchronize it with the Host through
   the normal client-first `voltmind put` path.
4. Write and synchronize the directly affected project/workstream/state pages.
5. After the evidence synchronization succeeds, register the same evidence
   revision. Do not register before the evidence page exists on the Host.

`put_page` does not infer the affected pages and does not automatically create a
registration receipt. Registration must be an explicit final step because the
client must report what it actually changed. The Host does not reclassify the
transcript on the ingest hot path.

## Registration input

Use the Host MCP tool `register_tracking_evidence` when it is available to the
agent. If the agent has a thin-client shell but no direct MCP tool binding, use
the equivalent thin-client command:

```text
voltmind register-tracking-evidence \
  --evidence-slug <canonical-source-evidence-slug> \
  --event-id <provider-event-id> \
  --event-version <provider-version-or-etag> \
  --evidence-type teams_thread \
  --tracking-refs '[{"provider":"teams","resource":"conversation","id":"<conversation-id>"}]' \
  --client-outcome applied \
  --affected-pages '["projects/<project-slug>","state/actions/<action-slug>"]' \
  --action-assignments '[{"action_slug":"state/actions/<action-slug>","assignees":[{"slug":"people/<person-slug>","display_name":"<name>","source_text":"<source wording>"}]}]'
```

The command is a normal shared operation and automatically routes through the
configured remote MCP on a thin client. It does not require a local
`database_url`. Do **not** use `voltmind call` for this on a thin client; that is
the trusted local database dispatcher and will fail when the client has no local
engine.

Required meanings:

- `evidence_slug`: the exact canonical source page already synchronized;
- `event_id` and optional `event_version`: the connector's stable identity and
  revision;
- `evidence_type`: the source filing category;
- `tracking_refs`: provider references preserved from the connector;
- `client_outcome`: `applied`, `created`, `review_needed`, `no_signal`, or
  `partial`;
- `affected_pages`: only project/workstream/state pages actually changed or
  created; a review-index-only result uses `[]`;
- `action_assignments`: the source-derived assignee projection for every
  affected action page.

Never put the raw transcript in the registration request. The operation records
hashes, identity, affected pages, and receipt history; it does not copy
Markdown, invoke an LLM, or edit project/workstream pages.

## Outcomes and retry

- `applied` — existing project/workstream/state pages were updated;
- `created` — an explicit project/workstream and/or state page was created;
- `review_needed` — the evidence was preserved but the route or semantic
  action needs review; use empty `affected_pages` when no canonical target was
  changed;
- `no_signal` — no durable project/workstream signal was found; use empty
  `affected_pages`;
- `partial` — some semantic work completed but the event is not complete; the
  runtime records it as review-required.

If the registration call fails after the Host evidence page was synchronized,
keep the local manifest in a retryable pending state and report the event as
incomplete. Do not re-ingest or duplicate the semantic pages. The company
server's source-scoped evidence sweep will later discover a stable evidence page
without a receipt and create a `registration_missing` pending receipt for Dream
maintenance.

## Remote-tool preflight

`register_tracking_evidence` is a core write-scope MCP operation, not a
Host-skill publication feature. A correctly configured source-bound OAuth client
with `write` (or `admin`) scope sees it in `tools/list`. If it is absent:

1. confirm the Host is running the same VoltMind build as the client and restart
   the HTTP MCP service after rebuilding;
2. confirm the OAuth client is bound to the intended source and has `write` or
   `admin` scope, not `read` only;
3. reconnect the MCP client so it refreshes `tools/list`;
4. keep the local evidence and manifest pending while the Host is repaired.

`mcp.publish_skills=true` is only needed when the agent must fetch the Host's
latest skill prose. It does not grant the registration operation or replace the
OAuth write scope.

