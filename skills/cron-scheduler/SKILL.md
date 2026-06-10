---
name: cron-scheduler
version: 2.0.0
description: VoltMind MVP scheduling guidance for Windows/PGLite.
triggers:
  - "schedule a job"
  - "cron"
  - "recurring job"
  - "autopilot schedule"
  - "quiet hours"
  - "daily maintenance"
tools:
  - get_health
  - list_jobs
  - get_job
  - cancel_job
mutating: true
---

# Cron Scheduler - VoltMind MVP

Use this skill when the user asks about recurring maintenance, schedules, or
autopilot-like behavior. In the Windows/PGLite MVP, do not install host
schedulers. Convert the request into explicit, user-run maintenance commands.

## Allowed MVP Maintenance

```bash
voltmind status
voltmind health
voltmind apply-migrations --yes
voltmind sync --no-pull --no-embed
voltmind embed --stale
voltmind jobs stats
```

Use `voltmind jobs list`, `voltmind jobs get <job-id>`, and
`voltmind jobs cancel <job-id>` for queue visibility and cancellation.

## Windows/PGLite Boundary

Do not install launchd, systemd, crontab, container startup scripts, or
autopilot on Windows/PGLite. PGLite's local file lock makes separate worker
processes risky for the MVP, and the inherited autopilot installer has no
Windows service target.

If a recurring workflow is needed, write a short runbook for the user with the
explicit commands and the intended cadence. Do not mutate the host scheduler.

## Suggested Manual Cadence

After editing or importing markdown:

```bash
voltmind sync --no-pull --no-embed
voltmind embed --stale
voltmind health
```

Before data testing:

```bash
voltmind apply-migrations --yes
voltmind status
voltmind health
```

## Anti-Patterns

- Calling inherited `gbrain` commands.
- Installing a host scheduler without a Windows-safe VoltMind target.
- Treating autopilot as required for first data testing.
- Submitting shell jobs or subagent jobs through hidden Minion surfaces.

## Output Format

```text
VOLTMIND SCHEDULE PLAN
Cadence: <manual or deferred>
Commands: <explicit VoltMind commands>
Reason: <why host scheduler was or was not used>
Frozen: <autopilot/worker request if applicable>
```
