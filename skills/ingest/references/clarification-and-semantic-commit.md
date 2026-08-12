### Deferred clarification and semantic commit

Run `skills/clarification-review/SKILL.md` whenever partial evidence leaves a
notable signal unresolved. The default policy is:

1. Persist raw evidence and the ingest manifest first.
2. Continue writing confirmed, independent facts and processing unrelated
   events.
3. Append a stable candidate to
   `state/indexes/ingest-clarification-review` and set
   `semantic_status: review_required` for the affected ingest unit.
4. After the available batch is durable, reconcile candidates against later
   events and Brain-First context; self-resolve or deduplicate before asking.
5. Use `ask-user` one question per turn. Ask immediately only when an affected
   write would merge/overwrite the wrong entity, cross an ownership/privacy
   boundary, create an actionable owner/deadline, or materially corrupt
   canonical state.
6. Preserve the user's answer as separate clarification provenance, then run
   the normal client-first local `voltmind put` write-through. Do not rewrite
   the raw source as though it contained the later oral context.

The generic clarification index is operational metadata. It is not a semantic
source citation and must not appear in `affected_pages` when registering
tracking evidence.

