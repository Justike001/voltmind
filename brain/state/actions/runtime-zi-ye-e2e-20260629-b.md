---
title: Runtime E2E full pipeline — Zi Ye message draft (v2)
status: open
priority: high
due: '2026-06-30T23:59'
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
    Draft coordinated Teams and Email messages to Zi Ye about the VoltMind admin
    action runtime writeback test. This is a full-pipeline test run.
  success_criteria:
    - Tool Router selects both Outlook Email and Teams routes.
    - Generate Plan queries Zi Ye's vault page through VoltMind query runtime.
    - Execution context includes both Tool Router and Generate Plan sections.
    - Interactive writeback finalizes successfully and marks this action done.
  output_target:
    type: draft
allowed_tools:
  - outlook_email
  - teams
max_autonomy: draft_only
updated: '2026-06-29'
---

## Action

Draft a concise Teams message and a fuller email to Zi Ye about the VoltMind admin action runtime full-pipeline writeback test (v2).

The drafts should mention that this is a runtime execution test, that the action is draft-only, and that final sending still requires human approval.

1. Query Zi Ye's vault page for current work and communication preferences.
2. Use Tool Router context for both Outlook Email and Teams.
3. Generate an execution plan from the queried context.
4. Assemble execution context that includes Tool Router and the generated plan.
5. Complete the writeback by reporting the drafted Teams and Email artifacts.
