# Execution preparation and scheduled runs

Read this reference only when the user chooses to arrange execution, asks about
source details, or a Desktop task wakes for an action. Simple completion,
closure, reminder-only, and skip replies use the main skill's one-command path.

If the user has already supplied an unambiguous confirmation or exact time,
reuse it; ask only for information or authority still missing. Retain reviewed
evidence and contract fields across turns. Consolidate writes with the confirmed
contract or final registration receipt rather than adding an edit per question.

### 2. Reconstruct details from local raw evidence

Do this only after the user chooses to arrange execution, or during a scheduled run. Ingest may have lost
details while producing semantic pages under context pressure; the preserved
Teams/Outlook source pages are the recovery layer.

1. Collect candidate source slugs from `source_refs`, `agent_contract.context_refs`,
   top-level `context_refs`, and wiki links or `[Source: ...]` citations in the
   action body. Keep only `sources/...` references and deduplicate them.
2. Resolve each source reference against the local vault without using DB/MCP:
   - An explicitly source-qualified reference such as `[source-id:slug]` maps
     to `<brain>/.sources/<source-id>/<slug>.md`.
   - For the default source, check `<brain>/<slug>.md`, for example
     `<brain>/sources/teams/event-slug.md`.
   - For an unqualified reference not found in the default source, search
     `<brain>/.sources/*/<slug>.md`, for example
     `<brain>/.sources/personal-alice-example/sources/teams/event-slug.md`.
   - Accept a non-default match only when it is unique. If multiple source IDs
     contain the same slug, record an evidence-routing ambiguity; do not choose
     by filename recency or query a database to guess.
3. Read the full relevant source files. Search inside them using the action
   title, named people, project, systems, filenames, and key nouns. Recover
   concrete details such as the original requester/speaker, exact wording,
   recipients/participants, shared file or attachment names, links, deadlines,
   destinations, constraints, message IDs, and timestamps.
4. Compare the recovered evidence with the existing action. Classify each
   candidate as:
   - `observed`: directly present in raw evidence and safe to add with citation;
   - `inferred`: plausible but not stated; keep as an unresolved question;
   - `conflicting`: disagrees with the action or another source; show the
     conflict and ask the user rather than overwriting either claim.
5. Retain missing `observed` details in the current packet. Write them once with
   the confirmed execution contract, in the appropriate fields and a managed
   `## Evidence Recheck` section. Do not write a separate recheck merely to ask
   the next question. Cite the exact local source slug and,
   when available, the Teams/Outlook timestamp and message/event ID. Preserve
   existing user-confirmed fields and never replace them with lower-authority
   evidence.
6. Recompute the missing-detail list from the packet. Ask only about information
   that remains missing, inferred, conflicting, permission-sensitive, or a real
   user preference.

Use this section format:

```markdown
## Evidence Recheck

- <recovered execution detail> [Source: [[source-qualified-or-local-slug]],
  Teams message <id>, <timestamp>]
- **Still unresolved:** <only the remaining gaps>
```

If an action from client-authored ingest cites raw evidence that cannot be found
in either local layout, do not claim the action is fully reconstructed. Show
the missing source slug and ask a single locate/recover,
reminder-only, or skip gate before requesting execution details. Remote MCP is
an optional later recovery path, never the first lookup.

### 3. Confirm execution details

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

### 4. Ask for the execution time

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

### 5. Apply the safety gate

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

### 6. Persist the schedule

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

### 7. Register the Desktop scheduled task

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

### 8. Continue the queue

Report the action title, normalized next run, timezone, execution posture, and
Desktop automation ID. Return to the main skill's lifecycle triage using one
`next` call. Do not reconstruct the next action's evidence before its triage
answer. Ask about only one action in each message.

## Scheduled-Run Workflow

1. Resolve the local vault root and read exactly the Markdown file named by the
   action slug. Do this before any CLI, database, or MCP operation.
2. Re-resolve the action's local raw evidence using the interview workflow's
   source-layout rules. Incorporate newly available observed details with exact
   citations, but block instead of asking interactively when a material conflict
   or required detail remains.
3. Verify that status is executable, the current time is due, the automation ID
   matches, and the Markdown receipt for the idempotency key has no successful
   run.
4. Enforce `risk_level`, approval, `max_autonomy`, `allowed_tools`, and
   `blocked_tools` from the Markdown contract, then execute the confirmed
   draft/artifact task with the currently available Desktop tools. Never widen
   the contract because a database or remote index is unavailable.
5. Use the VoltMind action runtime or remote MCP adapter only when it is already
   reachable and useful for execution/writeback. It is an optional adapter, not
   the source of truth or a prerequisite. Never initialize a nonexistent local
   Postgres instance and never add `--force`.
6. On success, atomically write the terminal status, outcome, artifact refs,
   run timestamp, automation ID, and idempotency receipt back to the same local
   Markdown file. On a policy, credential, permission, or missing-context
   failure, write `blocked` and the exact reason. Best-effort remote sync happens
   only after the local receipt is durable.
7. For one-shot actions, pause or complete the Desktop automation after a
   terminal result. For recurring actions, retain it only while the recurrence
   and stop condition remain valid.
