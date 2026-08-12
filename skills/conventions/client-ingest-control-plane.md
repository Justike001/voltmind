# Client Ingest Control Plane

This convention applies to every client-authored Teams, Outlook, meeting, or
external-file ingest. The local vault is the write-ahead truth surface; the
remote brain is its synchronized index, graph, and audit surface.

## Required order

1. Read the active schema and perform Brain-First Lookup.
2. Create or resume a durable local ingest manifest before connector reads.
3. Write raw evidence to the local vault first, with stable event identity.
4. Route semantic signal locally: update confirmed canonical pages, append
   project/workstream routing ambiguity to
   `state/indexes/project-tracking-review`, and append other notable ambiguity
   to `state/indexes/ingest-clarification-review`.
5. For every canonical semantic page, call the local thin-client writer
   (`voltmind put <slug> < page.md`). It validates the canonical draft contract
   before atomically writing the exact Markdown to `client_vault_path`.
6. Let that same local command send `put_page` only after the local write
   succeeds. Source evidence is synchronized before derived pages. Do not call
   remote MCP `put_page` directly for a client-first semantic write.
7. Call `register_tracking_evidence` only after the corresponding remote
   evidence write succeeds.
8. Record remote success, failure, or retry state in the local manifest.

Never write remote-only semantic state for a client ingest. A remote failure
leaves the local vault authoritative and the manifest in
`local_written_remote_pending`; retry synchronization idempotently from the
local file. Never advance a coverage checkpoint because a connector read
returned data but local persistence, remote synchronization, or registration
failed.

A direct call to the Host's remote MCP `put_page` is protected by the same
draft contract, but it is only the server-side safety gate: it cannot perform
the client's local write-ahead step. Client-first agents therefore route
semantic writes through the local VoltMind CLI/adapter.

## Evidence identity and coverage

- Evidence frontmatter must include `event_id`, `event_version` when
  available, `evidence_type`, and `tracking_refs`.
- Deduplicate Teams by `teams:<container_id>:<message_id>`.
- Keep one checkpoint and one manifest ledger per chat/channel. A 99-message
  result is `saturated`, never complete; a 429 is `rate_limited`, never
  `no_signal`.
- Preserve raw text, attachment markers, and message IDs. Do not invent
  meaning from opaque artifacts.

## File-reference contract

External files are references by default, not copied artifacts. Attach an
`ExternalFileReferenceV1` with at least:

```yaml
schema_version: 1
provider: microsoft
service: sharepoint
tenant_id: <tenant>
drive_id: <drive>
item_id: <item>
name: <file name>
web_url: <canonical link>
mime_type: <MIME type>
availability: accessible | unavailable | unknown
occurrence:
  platform: outlook | teams
  relation: attachment | inline_link | hosted_content
  conversation_id: <stable non-empty id>
  message_id: <stable non-empty id>
  source_uri: <stable non-empty source uri>
```

Keep `display_path`, `size_bytes`, `last_modified_at`, and `e_tag` when
the connector supplies them. Do not synthesize an eTag. Fetch or materialize
binary content only after an explicit user request; a readable-text capability
does not authorize copying or semantically summarizing the file.

## Non-blocking clarification queues

Ambiguous project/workstream signals are appended immediately to
`state/indexes/project-tracking-review`; they never remain only in a session
and never block raw capture or the rest of the batch. Each candidate records:

- source pages and message/event IDs;
- observed facts with citations;
- proposed route and the missing criterion;
- `pending_review`, `accepted`, `rejected`, or `superseded`;
- the resolution target and date once reviewed.

Only `accepted` candidates may create or alter a project, workstream, or
canonical state object. The queue index is operational metadata, not an
`affected_pages` target for `register_tracking_evidence`. For an
evidence-only candidate, register `client_outcome: review_needed` with an
empty `affected_pages` array.

Identity, semantic-route, missing-fact, relationship, time, owner, privacy, and
brain/source ambiguity is appended to
`state/indexes/ingest-clarification-review`. Each generic candidate records:

- a stable `question_id` derived from event/message identity, evidence span,
  and question type;
- source pages, exact observed excerpt, event ID/version, and proposed targets;
- the missing criterion, one proposed question, likely answers, confidence, and
  write impact;
- `pending_review`, `asked`, `answered`, `resolved`, `skipped`, or
  `superseded`;
- the verbatim user answer, resolution evidence, affected pages, and dates when
  applicable.

Classify source statements as `observed`, `inferred`, or `confirmed`. Raw
observations remain evidence; inferred meaning stays in the generic queue;
only confirmed assertions enter canonical semantic pages. The clarification
queue is operational metadata, not a semantic citation source and not an
`affected_pages` target.

Default to deferred review after the available batch is durable. Reconcile
against later messages, event versions, and Brain-First context before asking,
then use `skills/ask-user/SKILL.md` one question per turn. Ask immediately only
when the affected write would merge or overwrite the wrong entity, cross an
ownership/privacy boundary, create an actionable owner/deadline, or materially
corrupt canonical state. Raw capture and unrelated semantic routing never wait
for clarification.

After a user answer, retain the original source unchanged and store the answer
as separate `[Source: User clarification, YYYY-MM-DD]` provenance. Update the
local canonical Markdown, run local `voltmind put` so the exact file is written
and validated before remote `put_page`, then mark the candidate resolved. A
remote failure keeps `local_written_remote_pending` and retries from the local
file without asking the question again.

## Semantic and privacy gate

Create/alter a project only when goal, owner, scope, status, and completion
condition are explicit. Create/alter a workstream only when a durable
responsibility domain is explicit. Keep one-off support, ambiguous chats, and
incomplete meeting artifacts in evidence or the review queue.

Raw evidence may be private and minimally transformed. Canonical semantic pages
must not propagate passwords, OTPs, API keys, access tokens, personal phone
numbers, or detailed internal network identifiers. Preserve only the
non-sensitive fact needed to explain impact, status, and mitigation.

## Completion

An ingest unit is complete only when its coverage status, raw evidence,
semantic route or durable clarification candidate, remote synchronization, and
receipt are all durable. Report the remaining state explicitly: `saturated`,
`rate_limited`, `review_needed`, or `local_written_remote_pending`—never a
generic success.
