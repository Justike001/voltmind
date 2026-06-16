---
id: action-YYYY-MM-DD-slug
type: action
title: action-YYYY-MM-DD-slug
owner: people/owner-slug
scope: private | team | company
visibility: private | shared | restricted
sensitivity: internal | confidential | restricted
promotion: allowed
publish_level: never | candidate | user_approved | team_reviewed | company_state
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: open | in_progress | done | blocked | canceled
due: YYYY-MM-DD
priority: low | medium | high
related_people: []
related_project: projects/project-slug
related_projects: []
related_workstream: workstreams/workstream-slug
related_systems: []
context_refs: []
automation:
  eligible: true
  mode: manual | agent_assisted | agent_executable | scheduled_agent | watch_agent
  runtime: codex | browser | email | vault | api
  trigger: manual_checkbox | cron | due_time | condition
  run_at:
  schedule:
  condition:
  risk_level: low | medium | high | restricted
  requires_confirmation: true
  requires_approval: false
allowed_tools: []
blocked_tools: []
max_autonomy: draft_only | single_step | multi_step | autonomous_until_blocked
agent_contract:
  objective:
  context_refs: []
  output_target:
    type:
    path:
  success_criteria: []
writeback:
  on_success: []
  on_failure: []
tags: []
---

# action-YYYY-MM-DD-slug

## Action

One concrete executable task. Keep it short.

## Execution

- **Mode:** manual, agent_assisted, agent_executable, scheduled_agent, or watch_agent.
- **Trigger:** manual checkbox, cron, due time, or condition.
- **Runtime:** codex, browser, email, vault, or api.
- **Risk level:** low, medium, high, or restricted.
- **Confirmation:** whether the user must confirm before execution.
- **Approval:** whether explicit approval is required before execution.

## Agent Contract

- **Objective:** What the agent should accomplish.
- **Context refs:** Pages the agent must read before acting.
- **Output target:** Where the result should go.
- **Success criteria:** Observable conditions that mean the action succeeded.

## Context

- **People:** [[people/person-slug]]
- **Project:** [[projects/project-slug]]
- **Workstream:** [[workstreams/workstream-slug]]
- [[meetings/YYYY-MM-DD-topic]]
- [[sources/source-slug]]

## Tools

- **Allowed:** tools the agent may use.
- **Blocked:** tools the agent must not use.

## Writeback

- **On success:** timeline updates, status updates, generated artifact links, or external writeback targets.
- **On failure:** status update, error log, risk memory, or request for human intervention.

## Status

Open, in progress, done, blocked, or canceled.

<!-- timeline -->

## Timeline

- YYYY-MM-DD | Source - Created, assigned, blocked, completed, canceled, or published.
