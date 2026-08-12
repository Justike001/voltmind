# Semantic Projection

Read this reference whenever ingest creates or updates canonical entity,
project, workstream, decision, commitment, action, or risk pages.

## Entity and taxonomy routing

1. Resolve the active schema pack with `voltmind schema show --json`.
2. Prefer stable external identity over display-name matching. For Teams,
   prefer `conversation_id`, then `team_id + channel_id`, then aliases/name.
3. Run Brain-First Lookup before creating any page.
4. Apply the notability gate. Do not create pages for incidental mentions.
5. Rewrite current-state sections with the best confirmed understanding;
   timelines remain append-only and reverse chronological.

An internal Teams group chat may be a provisional `org` container only when no
formal org identity is known. Mark `org_kind: teams_group_chat`,
`classification_status: provisional`, and preserve stable Teams identifiers.
Do not infer Department, Function, Team, reporting line, or formal role.

## Entity propagation

For every notable person or company mentioned:

- create or update the canonical page;
- include source-backed current context only;
- add the event to relevant timelines;
- create relationships between co-mentioned entities when supported;
- add a backlink from the entity page to every derived page mentioning it.

An unlinked mention is incomplete ingest. Use the applicable schema link types;
do not invent relationships beyond the evidence.

## State objects and projects

Use the smallest durable object that represents the confirmed signal:

- project: bounded goal with owner/scope/status/completion condition;
- workstream: durable responsibility without a fixed end;
- decision: selected choice and rationale;
- commitment: promise or obligation;
- action: executable next step;
- risk: threat, impact, and mitigation context.

One evidence event may update multiple targets. Every target cites the evidence
page, and `affected_pages` lists only pages actually changed or created.

## Quality rules

- Preserve the user's exact phrasing for original ideas.
- Do not append stale state or duplicate existing facts.
- Do not claim completion, ownership, job titles, deadlines, or organizational
  structure that the evidence does not establish.
- Every fact and timeline entry has inline provenance.
- Do not create semantic artifact pages for unmaterialized file references.
