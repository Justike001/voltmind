---
name: meeting
version: 1.0.0
description: Human-reviewed VoltMind Meeting Loop for Personal Brain Phase 1.
triggers:
  - "meeting notes"
  - "meeting transcript"
  - "process this meeting"
  - "prepare meeting page"
  - "会议整理"
  - "会议纪要"
  - "会议抽取"
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
mutating: true
writes_pages: true
writes_to:
  - meetings/
  - state/actions/
  - state/commitments/
  - state/risks/
  - contribution/candidates/
---

# VoltMind Meeting Loop

Use this skill for Phase 1 Personal Brain meeting ingestion. This is a human-reviewed workflow: draft pages first, then write only after the user approves the proposed changes.

## Contract

This skill creates reviewed Personal Brain meeting drafts and related local state-object drafts. It never publishes externally in Phase 1.

## Read First

1. `docs/drafts/personal-brain-scaffold/RESOLVER.md`
2. `docs/drafts/personal-brain-scaffold/index.md`
3. `docs/drafts/personal-brain-scaffold/schema.md`
4. `docs/drafts/personal-brain-scaffold/policy/privacy-policy.md`
5. `docs/drafts/personal-brain-scaffold/policy/publish-contract.md`
6. `docs/drafts/personal-brain-scaffold/policy/action-risk-policy.md`

If the local `brain/` scaffold is missing, tell the user to run `voltmind init`.

## Output Pages

Draft these pages when supported by the meeting evidence:

- `meetings/YYYY-MM-DD-topic.md`
- `state/actions/YYYY-MM-DD-action-slug.md`
- `state/commitments/YYYY-MM-DD-commitment-slug.md`
- `state/risks/risk-slug.md`
- `contribution/candidates/cand-YYYY-MM-DD-signal-slug.md`

Do not write Team Brain, Company Brain, cloud publish, email send, ticket update, CRM update, ERP/MES update, or external writeback.

## Meeting Template

Preserve this section order:

```markdown
# YYYY-MM-DD Meeting Title

## Analysis

## Attendees

## Key Decisions

## Action Items

## Connections

## Candidate Contributions

- [ ] Publish decision to project
- [ ] Create action item
- [ ] Promote risk to team

## Transcript
```

Frontmatter must include `source_refs`, `related_entities`, `owner`, `scope`, `visibility`, `sensitivity`, `promotion`, and `publish_level`.

## Review Gate

Before any `voltmind put`, present:

- pages to create or update
- source evidence used
- detected actions, commitments, risks, and decisions
- candidate contributions, if any
- policy concerns or redactions

Only write after explicit user approval. Existing pages are updated additively; do not overwrite user text.

## Contribution Safety

- Never create contribution candidates from `private/`.
- Raw `daily/` content may only produce redacted candidates.
- `publish_level: never` blocks contribution candidates.
- `publish_level: candidate` means review is still required.

## Output Format

Report the proposed pages, policy checks, and pending approval. After approval, report written slugs and next suggested `voltmind import brain --no-embed` / `voltmind embed --stale` steps.

## Anti-Patterns

- Writing meeting pages without user approval.
- Publishing to Team Brain or Company Brain.
- Treating raw transcript text as publishable evidence.
- Creating action/risk/commitment pages without source refs.
