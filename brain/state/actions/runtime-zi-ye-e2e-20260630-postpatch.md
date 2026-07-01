---
title: Postpatch Native Runtime E2E - Zi Ye Drafts
status: on_schedule
priority: high
due: '2026-06-30T00:00'
automation:
  eligible: true
  mode: agent_executable
  runtime: codex
  trigger: manual
  risk_level: low
  requires_confirmation: false
related_people:
  - people/zi-ye
agent_contract:
  objective: >-
    Use VoltMind Admin Action runtime to draft coordinated Teams and Outlook
    Email messages to Zi Ye while validating the postpatch detached Codex
    launch, injected plan context, observability, and automatic writeback.
  success_criteria:
    - Tool Router selects both Outlook Email and Teams routes.
    - Generate Plan queries Zi Ye's vault page through VoltMind query runtime.
    - >-
      The /run execution prompt includes Tool Router, persisted plan, and
      injected plan runtime context for people/zi-ye.
    - Detached Codex runtime is actually detected after launch.
    - Detached Codex runtime creates draft artifacts itself.
    - Detached Codex runtime writes result.json itself.
    - Serve watcher finalizes result.json automatically without manual GET.
    - The action enters done state through VoltMind finalizer writeback.
  output_target:
    type: draft
allowed_tools:
  - outlook_email
  - teams
max_autonomy: draft_only
updated: '2026-06-30'
---

## Action

Draft a concise Teams message and a fuller Outlook email to Zi Ye about the
VoltMind Admin Action runtime postpatch launch test.

This is draft-only. Do not send any message. Final sending requires human
approval.

Use the injected /plan runtime context for Zi Ye if it is present in the action
prompt. Only re-query VoltMind if the injected context is missing or clearly
insufficient.

The detached runtime must append lifecycle events, create any draft artifacts
itself, and write the action result file itself before finishing.

<!-- timeline -->

- 2026-06-30 | VoltMind - Status set to on_schedule: Approved postpatch native runtime E2E test..
