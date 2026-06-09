---
name: daily
version: 1.0.0
description: Personal daily planning, review, briefing, and follow-up workflow.
triggers:
  - "daily plan"
  - "daily review"
  - "today brief"
  - "tomorrow plan"
  - "每日"
  - "今日计划"
  - "明日计划"
tools:
  - search
  - query
  - get_page
  - put_page
mutating: true
writes_pages: true
writes_to:
  - daily/
  - state/actions/
  - state/commitments/
  - state/risks/
---

# VoltMind Daily Loop

Use this skill for private daily work context. Read
`docs/drafts/personal-brain-scaffold/RESOLVER.md`,
`docs/drafts/personal-brain-scaffold/index.md`,
`docs/drafts/personal-brain-scaffold/schema.md`, and
`docs/drafts/personal-brain-scaffold/policy/privacy-policy.md` before writing
until the scaffold is promoted into `voltmind init` output.

## Contract

This skill maintains private daily context and only promotes operational state after user review.

Daily pages are private by default:

- `scope: private`
- `visibility: private`
- `publish_level: never`

Draft action, commitment, and risk pages only when the user asks to promote a daily note into operational state. Raw daily text is never published directly and never leaves the Personal Brain in Phase 1.

## Output Format

Return the daily page slug, detected follow-ups, and any proposed state-object drafts awaiting review.

## Anti-Patterns

- Publishing raw daily notes.
- Creating contribution candidates from `private/`.
- Replacing an existing daily page wholesale instead of appending.
