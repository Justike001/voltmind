---
name: ingest
description: Route generic content, Teams/Outlook evidence, project progress, and external file references into VoltMind. Use for generic ingest requests, Microsoft connector evidence, tracking-aware semantic writes, shared-drive references, or materialization. Read only the reference modules selected by the routing table, but always execute the core workflow and completion gates in this file.
triggers:
  - "ingest this"
  - "save this to brain"
  - "process this meeting"
  - "configure shared drive"
  - "configure raidrive"
  - "map z drive"
  - "sharepoint attachment"
  - "onedrive file"
  - "submit tracked evidence"
  - "ingest project progress"
tools:
  - search
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
  - sync_brain
  - search_file_refs
  - list_page_file_refs
  - attach_file_refs
  - file_ref_materialize
  - submit_ingestion_event
  - register_tracking_evidence
mutating: true
writes_pages: true
writes_to:
  - people/
  - orgs/
  - companies/
  - concepts/
  - meetings/
  - sources/
  - projects/
  - workstreams/
  - state/indexes/
  - state/actions/
  - state/decisions/
  - state/commitments/
  - state/risks/
---

# Ingest Skill

This file is the mandatory ingest control plane. Detailed variants live one
level below in `references/`; load only the modules selected below. A reference
may add constraints but may not reorder or bypass this core workflow.

Before writing, read:

- `skills/conventions/brain-first.md`
- `skills/conventions/quality.md`
- `skills/conventions/brain-routing.md`
- `skills/conventions/client-ingest-control-plane.md`
- `skills/conventions/page-template-contract.md`
- `skills/_brain-filing-rules.md`

## Reference Router

Read every matching reference completely before executing that part of the
workflow. Multiple rows may apply.

| Signal | Required reference |
|---|---|
| Any ingest that captures source material | [source-acquisition.md](references/source-acquisition.md) |
| Any canonical person/company/project/state write | [semantic-projection.md](references/semantic-projection.md) |
| Any `state/actions/*` candidate or write | [action-projection.md](references/action-projection.md) |
| Teams, Outlook Email, Outlook Calendar, or Microsoft relay | [microsoft-connectors.md](references/microsoft-connectors.md) |
| SharePoint, OneDrive, attachment, RaiDrive, SMB, UNC, mapped drive, or materialization | [file-references.md](references/file-references.md) |
| Project/workstream tracking, ambiguity, receipts, or client/Host write-through | [tracking-registration.md](references/tracking-registration.md) |
| Teams/Outlook cold start, history window, checkpoint, 99-result cap, saturation, or 429 | [cold-start-windows.md](references/cold-start-windows.md) |

Specialized content still routes first: `idea-ingest`, `media-ingest`, and
`meeting-ingestion`. They inherit this skill's evidence-first, citation,
entity-linking, semantic-completion, and tracking-registration gates.

## Contract

- Persist canonical raw evidence before derived semantic pages.
- Preserve stable event identity: `event_id`/`tracking_event_id`,
  `event_version`/`tracking_event_version`, `evidence_type`, and
  `tracking_refs` when available.
- Classify statements as `observed`, `inferred`, or `confirmed`; canonical
  semantic pages contain only confirmed assertions.
- Run Brain-First Lookup before creating or updating entities and tracking
  targets.
- Cite every durable fact inline with date and provenance.
- Maintain entity cross-links, backlinks, and relevant timelines.
- Preserve structured intermediates such as action assignees; never recover
  identity from generated summary prose.
- Complete semantic ingest only after deterministic coverage checks and receipt
  registration pass.
- Client-agent ingest may write `projects/`, `workstreams/`, and canonical
  action/decision/commitment/risk pages after Brain-First Lookup.
- Keep client-authored ingest local-vault first. Host raw-ingest compatibility
  is a separate path and never repeats client semantic interpretation.

## Core Workflow

1. **Route the source.** Determine brain, source, specialized ingest skill, and
   every matching reference module. Verify the active schema pack before filing.
2. **Capture evidence.** Persist raw text/transcript or a durable raw pointer and
   stable file-reference metadata before semantic interpretation. Record the
   ingest manifest/control state when the selected connector workflow requires
   it.
3. **Parse once into structured evidence.** Extract people, companies, dates,
   events, actions, decisions, commitments, risks, file references, and tracking
   references. Retain exact excerpts and connector identities. Classify every
   statement as observed, inferred, or confirmed.
4. **Preserve action assignees before prose generation.** For every action
   candidate, retain:

   ```yaml
   action_slug: state/actions/example-action
   assignees:
     - slug: people/alice-example
       display_name: Alice Example
       source_text: Alice Example
   ```

   Resolve adjacent connector mentions from structured mention nodes or known
   aliases. Do not re-extract or guess assignees from an action summary.
5. **Run Brain-First Lookup and taxonomy routing.** Resolve stable identities,
   existing entities, projects/workstreams, bindings, aliases, backlinks, and
   the active schema type/path before writing.
6. **Handle ambiguity without blocking independent work.** Preserve evidence;
   route project candidate ambiguity to `state/indexes/project-tracking-review`
   and identity/fact/relationship/owner/time/privacy/routing ambiguity to
   `state/indexes/ingest-clarification-review`. Do not promote guesses.
7. **Write canonical pages locally.** Update current state rather than appending
   stale state. Write citations, entity links, backlinks, timelines, and
   canonical state objects. Use local `voltmind put` for validated atomic
   write-through.
8. **Validate deterministic coverage.** Confirm source citations, affected
   pages, entity backlinks, and action assignee coverage. Every action assignee
   must appear in `owner` or `related_people`, as an explicit body wikilink, and
   on the person page as a backlink to the action.
9. **Synchronize and register.** After the exact local pages reach the Host,
   call `register_tracking_evidence` with actual `client_outcome`,
   `affected_pages`, and `action_assignments`. A review-index-only result uses
   `review_needed` with an empty `affected_pages` list.
10. **Set completion state conservatively.** Any failed deterministic check,
    ambiguity affecting canonical truth, missing write, or failed receipt sets
    `semantic_status: review_required` or another non-complete state. Never mark
    semantic work complete until the same event revision passes.
11. **Schedule only after durability.** If canonical `state/actions/*.md` pages
    were created, hand their exact local paths and slugs to
    `skills/schedule-actions/SKILL.md`. Extraction is not execution consent.

## Citation Requirements

- User statement: `[Source: User, {context}, YYYY-MM-DD]`
- Meeting: `[Source: Meeting "{title}", YYYY-MM-DD]`
- Email/message: `[Source: email from {name} re: {subject}, YYYY-MM-DD]`
- Web: `[Source: {publication}, {URL}, YYYY-MM-DD]`
- Social: `[Source: X/@handle, YYYY-MM-DD](URL)`
- Synthesis: `[Source: compiled from {sources}]`

## Completion Gate

An ingest unit is complete only when:

- raw evidence or its durable pointer exists;
- stable identity and source routing are recorded;
- every confirmed semantic write exists locally and remotely;
- every fact is cited;
- every mentioned notable entity is resolved or durably queued for review;
- links, backlinks, and timelines pass the applicable coverage checks;
- every affected action has a preserved and validated `action_assignments`
  projection;
- `register_tracking_evidence` records the actual outcome without conflict.

Otherwise preserve progress and use `review_required`, `partial`, `blocked`,
`rate_limited`, or the applicable non-complete status.

## Output Format

```text
INGESTED: [title]
Page: [slug]
Type: [type]
Source: [source description]
Entities: [created/updated/review-required]
Back-links: [count/status]
Timelines: [count/status]
Raw source: [path/pointer]
Semantic status: [complete/review_required/no_signal/blocked]
Receipt: [registered/review_needed/conflict/pending]
```

## Anti-Patterns

- Generating semantic pages before durable raw evidence.
- Reconstructing assignees, owners, or entities from generated summaries.
- Treating an unlinked mention as complete ingest.
- Marking saturated, rate-limited, ambiguous, partially written, or
  receipt-pending work complete.
- Calling Host `put_page` as a substitute for required client-first local files.
- Reinterpreting client-authored semantic writes again on the server hot path.
- Scheduling an extracted action without the schedule-actions interview gate.

## Tools Used

- `search`, `query`, `get_page` — Brain-First Lookup.
- `put_page` — validated semantic write-through.
- `add_link`, `add_timeline_entry` — graph and timeline propagation.
- `search_file_refs`, `list_page_file_refs`, `attach_file_refs`,
  `file_ref_materialize` — external file reference lifecycle.
- `register_tracking_evidence` — semantic receipt and deterministic completion
  gate.
- `submit_ingestion_event` — company-server raw-ingest compatibility only.
