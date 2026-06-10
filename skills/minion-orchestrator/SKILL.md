---
name: minion-orchestrator
version: 2.0.0
description: VoltMind MVP job visibility and queue inspection for Windows/PGLite.
triggers:
  - "minions"
  - "job queue"
  - "background jobs"
  - "what jobs are running"
  - "job status"
  - "cancel job"
  - "jobs stats"
tools:
  - get_job
  - list_jobs
  - cancel_job
  - get_job_progress
mutating: true
---

# Minion Orchestrator - VoltMind MVP

Use this skill for VoltMind job visibility only. In the Windows/PGLite MVP, the
public route exposes stable queue read/cancel commands, but not inherited
Minion submission, shell jobs, subagent fan-out, worker daemons, or supervisors.

## Allowed Commands

```bash
voltmind jobs list
voltmind jobs get <job-id>
voltmind jobs cancel <job-id>
voltmind jobs stats
```

These are safe for agents to use when the user asks what is running, whether a
job is stuck, or whether a waiting/active job should be cancelled.

## Windows/PGLite Boundary

PGLite uses an exclusive local file lock. Separate worker/supervisor processes
are not part of the MVP route because they can contend with the active local
runtime. On Windows, the inherited autopilot installer also has no service
target.

If the user asks for Minions install, shell jobs, subagent fan-out, worker
daemon startup, or autopilot scheduling, report that those flows are not active
in the Windows/PGLite MVP and offer the closest explicit command:

- `voltmind sync --no-pull --no-embed` for indexing changed markdown.
- `voltmind embed --stale` for embedding refresh.
- `voltmind jobs stats` for queue readout.
- `voltmind status` and `voltmind health` for runtime health.

## Phase C.5

For the Windows/PGLite setup phase, run:

```bash
voltmind apply-migrations --yes
voltmind status
voltmind health
voltmind jobs stats
```

Do not run `voltmind autopilot --install` on Windows/PGLite.

## Anti-Patterns

- Calling inherited `gbrain` commands.
- Suggesting `voltmind jobs submit`, `voltmind jobs work`, or worker daemons as
  MVP public commands.
- Installing launchd, systemd, crontab, or container startup scripts on Windows.
- Treating background automation as required for first data testing.

## Output Format

```text
VOLTMIND JOBS
Status: <status/health summary if checked>
Queue: <jobs stats/list summary>
Action: <cancelled job or no mutation>
Frozen: <requested worker/autopilot flow, if any>
```
