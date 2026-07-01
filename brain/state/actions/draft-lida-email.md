---
id: action-2026-06-25-draft-lida-email
type: action
title: Draft Test Email to Lida
owner: people/justike-liu
scope: private
visibility: private
sensitivity: internal
promotion: allowed
publish_level: never
source_refs: []
related_entities: []
created: 2026-06-25T00:00:00.000Z
updated: '2026-06-30'
status: open
priority: medium
related_people: []
related_project: null
related_projects: []
related_workstream: null
related_systems: []
context_refs: []
automation:
  eligible: true
  mode: agent_assisted
  runtime: codex-interactive
  trigger: manual_checkbox
  risk_level: low
  requires_confirmation: false
  requires_approval: false
allowed_tools:
  - outlook_email
blocked_tools: []
max_autonomy: single_step
agent: default
skill: null
agent_contract:
  objective: >-
    Use @outlook-email to draft an email to Lida (search contacts for Lida).
    Subject: [VoltMind Test] Hello from Harness Agent. Body: Hi Lida, this is a
    test email drafted by the VoltMind Action Runner -> Codex Interactive
    pipeline. No action needed, just a pipeline verification. Do NOT send, only
    save as draft.
  context_refs: []
  output_target:
    type: outlook_draft
  success_criteria:
    - Draft email to Lida exists in Outlook drafts
writeback:
  on_success: []
  on_failure: []
tags:
  - test
  - lida
  - outlook
  - harness-agent
---

# Draft Test Email to Lida

## Action

Draft a test email to Lida via @outlook-email. Do not send.

## Execution

- **Mode:** agent_assisted
- **Runtime:** codex-interactive
- **Risk:** low

## Status

Open.

<!-- timeline -->

## Timeline

- 2026-06-25 | VoltMind - Created.
