---
name: voltmind-advisor
version: 1.0.0
description: |
  Proactive "make the most of voltmind" coaching. Runs `voltmind advisor` on a
  cadence and pings the user with the top high-leverage actions for their brain:
  schema health, stalled work, sync failures, brain score, and local skill-tree
  routing gaps. Read-only; always asks before fixing.
triggers:
  - "what should I do to get more out of voltmind"
  - "is my brain set up right"
  - "voltmind advisor"
  - "advise me on my brain"
  - "what should I fix next"
  - "weekly brain checkup"
tools:
  - advisor
mutating: false
---

## VoltMind thin-client boundary

- **Semantic writes:** Durable brain-page, fact, and entity writes go through the thin-client local `voltmind put` workflow with source attribution. A remote `put_page` call must not substitute for this client-first evidence write.
- **Expanded capabilities:** `entity` is the zero-LLM structured entity-card operation; `synthesize` is the slower, LLM-backed cross-page reasoning operation. Both are available to thin clients over read-scoped MCP and must retain their distinct cost and latency semantics.
- **Advisor split:** The `advisor` MCP operation returns brain/runtime diagnostics only. Local `voltmind advisor` combines that report with workspace skill-tree and routing diagnostics; workspace paths and state never cross MCP.
- **Host/local harness workflows:** `sync`, `embed`, `extract`, `transcripts`, `files`, `lsd`, DB repair, and Git history rewrite run in the Host or local harness workflow. They are not thin-client MCP tools.
- **Harness prerequisites:** External web access, Git, shell/exec/read tools, and raw filesystem access are harness prerequisites supplied by the executing host/workspace. They must not be presented as VoltMind MCP capabilities.


# voltmind Advisor

> **Convention:** See `skills/conventions/brain-first.md`. This skill is the
> proactive voice of the brain — it tells the owner how to run it better.

## Contract

This skill guarantees:
- **Read-only.** `voltmind advisor` never mutates. It computes a ranked list of
  actions from existing brain state.
- **Print, never execute.** You SHOW the user the findings and ASK before running
  any fix. The user owns every decision.
- **Bounded nagging.** On a cadence, surface only what changed or what's
  critical; don't repeat an ignored low-severity item every run.

## When to run

- On demand when the user asks "how do I get more out of this brain?"
- On a **weekly** cadence via the cron recipe below (even idle brains get a
  "here's how to run this better" ping).

## How to run it

```bash
voltmind advisor --json
```

Exit code is the severity gate: `0` clean, `1` warn, `2` critical. The JSON
payload is `{ schema_version, surface, status, findings, diagnostics }`. Each finding has:

- `severity` — `critical` | `warn`
- `title` — one-line why-it-matters
- `surface` — `brain` for MCP-visible findings or `workspace` for local-only findings
- `next_step.surface` and `next_step.command` — where the operator can investigate further

## What to do with the findings

1. Read the findings, highest severity first.
2. Summarize the top 1-3 to the user in their own channel/voice. Lead with any
   `critical` item (e.g. pending migrations).
3. For each, show `next_step.command` and **ask** whether to run it.
4. Run the separate Host/local command only after the user agrees. The advisor
   has no apply mode and never turns a diagnostic into execution authority.

## Cron recipe (weekly checkup)

Install a weekly job via the `cron-scheduler` skill. Keep the prompt THIN — the
job just reads this skill and runs the advisor:

- **Schedule:** weekly, one quiet-hours-respecting slot (e.g. Monday 09:00 local).
- **Job prompt:** `Read skills/voltmind-advisor/SKILL.md and run voltmind advisor --json. If anything is critical or new since last run, ping me with the top items and the exact fix commands. Ask before fixing.`
- **Idempotent:** the advisor is read-only, so a double-fire is harmless.

The current VoltMind adapter does not persist advisor history. Scheduled callers
should suppress unchanged output in their own automation state.

## Output Format

When you surface advisor findings to the user, lead with severity and keep it
scannable:

```
🧠 voltmind checkup — 2 things worth your attention

CRITICAL  Schema migrations are pending.
          Fix: voltmind apply-migrations --yes   (want me to run it?)

WARN      voltmind 0.44 is available (you're on 0.43).
          Fix: voltmind upgrade
```

- One block per finding, highest severity first.
- Always show the exact `fix` command and ASK before running it.
- If nothing is pressing, say so in one line ("brain looks healthy") — don't
  manufacture work.

## Anti-Patterns

- **Running a fix without asking.** The advisor is read-only by contract. Never
  run a reported `next_step.command` without the user's explicit yes.
- **Dumping the raw JSON at the user.** Translate findings into their voice; lead
  with what matters.
- **Re-nagging ignored low-severity items every run.** Use the "new since last
  run" delta; respect the user's prior non-action.
- **Treating `info` like `critical`.** Only block/insist on `critical` findings
  (pending migrations). `info` is a gentle nudge.
- **Calling the MCP `advisor` op for workspace install state.** Over MCP the
  advisor returns brain-state signals only; uninstalled-skill findings are a
  local-CLI concern.
