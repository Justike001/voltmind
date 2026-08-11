---
name: schedule-actions
description: Clarify every executable VoltMind action with the user, persist an execution-ready contract and exact time, and register an idempotent ChatGPT desktop scheduled task. Use after ingest creates pages in state/actions/, when the user asks to schedule pending actions, or when a scheduled run wakes up to execute one action.
---

# Schedule Actions

Turn newly ingested `state/actions/` pages into explicit, reviewable execution
contracts and ChatGPT desktop scheduled tasks. Process one action at a time so
each user decision survives the choice-gate boundary.

## Contract

- Read `skills/brain-ops/SKILL.md` for write, citation, routing, and safety
  conventions, and read `skills/ask-user/SKILL.md` before every user decision
  gate. For `state/actions/` discovery and reads, the local-Markdown-first rule
  in this skill is an explicit exception to brain-ops' generic
  `search -> query -> get` lookup sequence.
- Treat the local vault Markdown under `state/actions/` as the canonical action
  source. Read it before any database, VoltMind CLI action-index, or MCP call.
  A missing local Postgres database must never block action discovery,
  clarification, scheduling, or a scheduled run.
- Ask about every open action individually. Never infer consent for one action
  from the user's answer about another action.
- Ask one question per turn, offer 2-4 self-explanatory choices including Skip
  or Cancel, and stop the turn immediately after the question.
- Persist the confirmed execution contract, exact schedule, timezone, safety
  boundary, and Desktop automation identity on the action page before moving to
  the next action.
- Register schedules only through the ChatGPT/Codex automation-management tool.
  Do not emit raw recurrence directives or fall back to OS cron, Task Scheduler,
  shell loops, or sleeping processes.
- Make every run idempotent. A completed, canceled, blocked, or already-running
  action must not execute again.

## Modes

Choose the mode from the current turn:

- **Interview mode:** ingest just created actions, or the user asks to schedule
  pending actions. Run the interview workflow below.
- **Scheduled-run mode:** a Desktop scheduled task names exactly one action slug.
  Run only that action using the scheduled-run workflow. Never restart the
  interview from an unattended run.

## Interview Workflow

### 1. Build the queue

1. Resolve the local vault root. Prefer the configured client vault path; then
   check `<workspace>/brain/state/actions/`; then `<workspace>/state/actions/`.
   Do not infer a server filesystem path and do not open a database to find it.
2. Enumerate `*.md` directly from that local directory and parse each file's
   frontmatter and body. This local Markdown is the queue source of truth.
3. Select open actions and `on_schedule` actions whose Desktop automation
   identity is missing. Exclude `done`, `canceled`, and archived actions.
   Exclude a scheduled action
   when its persisted Desktop automation still exists and matches the action.
4. Sort by due time, priority, then slug. Work on exactly one action until it is
   scheduled or skipped.

Do not call `voltmind actions scan`, `list`, or `get` while building or reading
the interview queue. Those commands operate through the configured database
engine and may try a nonexistent client-side Postgres instance. Query a remote
action index through MCP only when the user explicitly requests server state;
never use it ahead of the local Markdown.

If there are no candidates, report that no action needs scheduling and stop.

### 2. Confirm execution details

Read the full local action page first. Resolve cited source context from linked local
Markdown when available; use DB/MCP only as optional gap-fill after the action is
already loaded. Present a compact summary:

- objective and expected deliverable;
- inputs and context references;
- intended destination or system;
- allowed and blocked tools;
- success criteria and stop conditions;
- maximum autonomy and external side effects;
- missing or ambiguous details.

If any critical field is missing, do not offer confirmation yet. Ask for only
the next missing detail and use a gate such as Provide detail, Reminder only, or
Skip action. Stop the turn. Repeat on later turns until the contract is complete.

Once all critical fields are present, use the `ask-user` choice gate:

1. **Confirm details — use the complete contract shown**
2. **Revise details — provide corrections next**
3. **Reminder only — do not execute the action**
4. **Skip action — leave it unscheduled**

Stop the turn after asking. If the user chooses revision, ask for one missing or
ambiguous detail per subsequent turn. Offer Confirm, Revise, and Skip choices
after showing the updated complete contract. Do not stack detail and schedule
questions.

A confirmed executable contract must contain:

```yaml
agent_contract:
  objective: <one concrete outcome>
  execution_details: <user-confirmed instructions>
  context_refs: []
  inputs: []
  destination: <artifact, system, or recipient>
  success_criteria: []
  stop_conditions: []
allowed_tools: []
blocked_tools: []
max_autonomy: draft_only # or single_step
```

Preserve existing fields not changed by the user. Record the user's confirmation
with a dated source citation in the page body. Never store secrets, session
tokens, or passwords in the page or scheduled prompt.

### 3. Ask for the execution time

Only after the details are confirmed, use a separate `ask-user` choice gate:

1. **Choose exact time — one execution at a local date and time**
2. **Choose recurrence — repeat on a stated cadence**
3. **Execute now — run after the final safety check**
4. **Skip scheduling — keep the confirmed contract only**

Stop the turn. For exact time, ask the user for date, clock time, and timezone in
one focused follow-up. For recurrence, ask for cadence, clock time, timezone,
and an optional stop condition in one focused follow-up. Resolve relative dates
against the current date and echo the normalized ISO-8601 time plus IANA
timezone for confirmation. If the time is in the past, ask for a new time.

### 4. Apply the safety gate

Before registration, derive the narrowest safe execution posture:

- `low`: executable after the user has confirmed details and schedule.
- `medium`: require a final approval choice and run `voltmind actions approve
  <slug>` only after explicit approval.
- `high` or `restricted`: do not schedule unattended execution. Offer a
  reminder/review task or Skip; the VoltMind action policy requires human review.
- The current VoltMind V1 action runtime is draft/artifact-only even after
  confirmation. Do not promise that a scheduled run will send messages, purchase,
  delete, approve, or perform another final external mutation. Schedule a draft or
  reminder for those actions and respect `blocked_tools` regardless.

Do not use `--force` to bypass an action policy. Do not schedule an action whose
runtime would wait for interactive stdin.

### 5. Persist the schedule

Update the action page in UTF-8 and preserve unrelated content. Use this shape:

```yaml
status: on_schedule
automation:
  eligible: true
  mode: agent_executable
  runtime: codex
  trigger: due_time
  run_at: <ISO-8601 timestamp with offset>
  timezone: <IANA timezone>
  schedule_kind: one_shot # or recurring
  interview_status: confirmed
  requires_confirmation: false
  requires_approval: false
  desktop_automation_id: <fill after registration>
  desktop_automation_name: <stable name>
  idempotency_key: <stable key derived from slug and schedule>
```

For reminder-only choices, set `mode: manual` and ensure the scheduled prompt
only reminds or requests review. Keep approval fields truthful; medium-risk
approval is persisted by VoltMind rather than fabricated in Markdown.

After the page write, treat the local Markdown update as complete. If a remote
VoltMind MCP write-through is configured, synchronize the exact persisted file
as a best-effort post-step and record `local_written_remote_pending` when it
fails. Do not initialize local Postgres, rerun `voltmind actions scan`, or block
Desktop schedule registration merely to refresh a derived database index.

### 6. Register the Desktop scheduled task

Use the currently surfaced ChatGPT/Codex automation-management tool. For a local
VoltMind action:

1. Resolve the current project with the project-listing tool.
2. Prefer a standalone project scheduled task because each action run is an
   independent execution against local project state. Use local execution when
   result writeback must update this checkout; use a worktree only when the
   confirmed contract explicitly requires isolated code changes and provides a
   writeback path.
3. Use the tool's supported one-time schedule for a single execution, or its
   structured recurrence fields for a repeating action. Do not hand-author or
   display a raw recurrence rule.
4. Give the task a stable name containing the action slug. Search existing
   automations by ID/name/prompt and update a match instead of creating a
   duplicate.
5. Use the default model and reasoning effort unless the user explicitly chose
   another setting.
6. Persist the returned automation ID and exact normalized schedule back to the
   action page. If registration fails, keep `status: open`, record the error,
   and do not claim that the action is scheduled.

Use a thin, durable scheduled prompt:

```text
Use $schedule-actions in scheduled-run mode for <action-slug>. Re-read the
action page, enforce its policy and idempotency key, execute only that action,
write back the result, and stop. Do not ask interactive questions.
```

For a one-shot task, configure native single-occurrence behavior when supported.
If the surface cannot express a one-shot schedule, fail clearly instead of
creating an endlessly recurring substitute.

### 7. Continue the queue

Report the action title, normalized next run, timezone, execution posture, and
Desktop automation ID. Then start the next action by returning to the details
gate. Because `ask-user` stops each turn, never ask about two actions in one
message.

## Scheduled-Run Workflow

1. Resolve the local vault root and read exactly the Markdown file named by the
   action slug. Do this before any CLI, database, or MCP operation.
2. Verify that status is executable, the current time is due, the automation ID
   matches, and the Markdown receipt for the idempotency key has no successful
   run.
3. Enforce `risk_level`, approval, `max_autonomy`, `allowed_tools`, and
   `blocked_tools` from the Markdown contract, then execute the confirmed
   draft/artifact task with the currently available Desktop tools. Never widen
   the contract because a database or remote index is unavailable.
4. Use the VoltMind action runtime or remote MCP adapter only when it is already
   reachable and useful for execution/writeback. It is an optional adapter, not
   the source of truth or a prerequisite. Never initialize a nonexistent local
   Postgres instance and never add `--force`.
5. On success, atomically write the terminal status, outcome, artifact refs,
   run timestamp, automation ID, and idempotency receipt back to the same local
   Markdown file. On a policy, credential, permission, or missing-context
   failure, write `blocked` and the exact reason. Best-effort remote sync happens
   only after the local receipt is durable.
6. For one-shot actions, pause or complete the Desktop automation after a
   terminal result. For recurring actions, retain it only while the recurrence
   and stop condition remain valid.

## Output Format

During interview mode, output only the current action summary and one choice
gate. After registration, use:

```text
Scheduled: <action title>
Action: <state/actions/slug>
Run: <normalized time and timezone>
Posture: <execute | draft | reminder>
Automation: <name and id>
Remaining unscheduled actions: <count>
```

During scheduled-run mode, report the terminal status, concise outcome,
artifact references, and whether the automation was completed, paused, or kept.

## Anti-Patterns

- Asking about multiple actions or multiple decision gates in one message.
- Scheduling from an ingest summary without reading each canonical action page.
- Reading the action database, local Postgres, or remote MCP before the local
  `state/actions/*.md` file.
- Treating a due date as permission to execute or inventing missing details.
- Creating duplicate automations after a retry or ingest replay.
- Putting secrets or long source context into the scheduled prompt.
- Using raw cron/RRULE text, OS schedulers, `--force`, or a sleeping process.
- Claiming a schedule exists before the Desktop automation tool returns an ID.
- Letting an unattended run block on interactive confirmation.
