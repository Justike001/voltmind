# Ingest completion handoff

Read this for user-visible ingest completion, including directly invoked
meeting/media/idea ingestion. It owns the receipt and action handoff.

## Completion order

1. Finish evidence preservation, canonical updates, validation, synchronization
   attempts and tracking/receipt checks under the ingest core workflow.
2. Return a concise receipt for this request: processed/duplicate items, changed
   canonical pages, unresolved review records, and pending/failed synchronization
   or registration. Preserve evidence links and coverage cutoffs. A partial
   ingest is not complete; durable local evidence remains durable on sync failure.
3. Continue skills/schedule-actions/SKILL.md for durable local action candidates,
   preserving its lifecycle triage and execution consent requirements. Extraction
   and receipt delivery do not constitute execution consent.

Pass exact local action paths/slugs, raw source references, event identities and
versions, resolved brain/source identities and receipt status to action handling.
Do not expose private vault paths in public artifacts. High-impact clarification
gates still apply before dependent canonical writes.

Prefer the `voltmind actions schedule` local CLI fast path in that skill for
queue discovery and persisting each user decision. Start with `next`; use direct
`decide SLUG --decision ... --expect SHA --source ... --next` for lifecycle
answers. Complete, obsolete, reminder-only, and skip replies do not need new
Evidence Recheck, put-local, or automation-memory writes. Reuse the returned
card; load raw evidence only if the user proceeds with execution preparation.
Batch decision sync and required memory updates at the interview boundary.
The CLI does not register Desktop automations.

## Batch and reporting boundary

The outermost user-visible request owns one receipt; nested specialized skills
return their results to that owner. Zero-action and duplicate-only runs still
return the receipt. Unattended events do not create recurring tasks or
notifications on their own. Existing durable evidence and receipts remain the
handoff boundary; downstream reporting failures never roll back ingest or block
action handling.
