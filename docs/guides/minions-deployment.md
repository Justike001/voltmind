# Minions Worker Deployment Guide

Keep `voltmind jobs work` running across crashes, reboots, and Postgres
connection blips. Written for agents to execute line-by-line.

## The problem

The persistent worker can die silently from:

- Database connection drops (Supabase/Postgres maintenance or network blips).
- Lock-renewal failures → the stall detector eventually dead-letters jobs.
- Bun process crashes with no automatic restart.
- Internal event-loop death (PID alive, worker loop stopped).

When the worker dies, submitted jobs sit in `waiting` forever. The
canonical answer is `voltmind jobs supervisor` — a first-class CLI that
spawns `voltmind jobs work` as a child and auto-restarts it on crash.

## Worker supervision

### The canonical pattern

`voltmind jobs supervisor` is an auto-restarting wrapper around
`voltmind jobs work`. It writes a PID file, restarts the worker on crash
with exponential backoff (1s → 60s cap), emits lifecycle events to an
audit file, and drains gracefully on SIGTERM (35s worker-drain window
before SIGKILL). Exit codes are documented so agents can branch on them.

**Typical commands:**

```bash
# Start in the foreground (blocks; Ctrl-C to stop).
voltmind jobs supervisor --concurrency 4

# Start detached — returns {"event":"started","supervisor_pid":…} on stdout.
voltmind jobs supervisor start --detach --json

# Check liveness without reading log files.
voltmind jobs supervisor status --json

# Graceful stop (SIGTERM + drain wait + SIGKILL fallback).
voltmind jobs supervisor stop
```

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | Clean shutdown (SIGTERM/SIGINT received, worker drained) |
| 1 | Max crashes exceeded (worker kept dying) |
| 2 | Another supervisor holds the PID lock |
| 3 | PID file unwritable (permission / path error) |

An agent seeing exit=2 can safely treat it as "one is already running";
exit=1 should page a human.

### Which supervisor when?

The supervisor solves in-process crash recovery. Platform-level
supervision (systemd, Fly, Render) handles host-level failures. You
usually want both.

| Environment | Recommendation |
|---|---|
| **Container (Fly / Railway / Render / Heroku)** | `voltmind jobs supervisor` runs as PID 1. The platform restarts the container on OOM / host loss; supervisor restarts the worker on crash. See [Fly.io](#flyio) / [Render / Railway / Heroku](#render--railway--heroku). |
| **Linux VM with systemd** | Two-layer recommended: systemd supervises `voltmind jobs supervisor`, which in turn supervises `voltmind jobs work`. Buys you automatic restart on reboot (systemd) plus fast crash recovery (supervisor). See [systemd](#systemd). |
| **Dev laptop / macOS** | `voltmind jobs supervisor` in a terminal. Ctrl-C stops it. No system-level setup needed. |

### Variables used in this guide

Substitute these once before copy-pasting any snippet.

| Variable | Meaning | Typical value |
|---|---|---|
| `$VOLTMIND_BIN` | Absolute path to the `voltmind` binary | `$(command -v voltmind)` — often `/usr/local/bin/voltmind` or `~/.bun/bin/voltmind` |
| `$VOLTMIND_WORKER_USER` | OS user that owns the worker process | the same user that ran `voltmind init`; never `root` |
| `$VOLTMIND_WORKSPACE` | `cwd` for shell jobs submitted by this deployment | absolute path, e.g. `/srv/my-brain` |
| `$VOLTMIND_ENV_FILE` | Secrets file sourced by systemd / shell | `/etc/voltmind.env` (mode 600) |

### Preconditions

Run these before any deployment step.

```bash
# 1. voltmind is on PATH and resolves to an absolute location.
command -v voltmind || { echo "voltmind not on PATH. Install, then retry."; exit 1; }

# 2. DATABASE_URL points at reachable Postgres.
#    (Supervisor is Postgres-only. PGLite's exclusive file lock blocks the
#    separate worker process. If `config.engine === 'pglite'` the CLI rejects
#    with a clear error.)
voltmind doctor --fast --json | jq '.checks[] | select(.name=="db_connectivity")'

# 3. Schema is up to date. If version=0 or status=="fail":
#    voltmind apply-migrations --yes
voltmind doctor --fast --json | jq '.checks[] | select(.name=="schema_version")'

# 4. If you plan to submit `shell` jobs, pass --allow-shell-jobs to the
#    supervisor (or export VOLTMIND_ALLOW_SHELL_JOBS=1 before starting).
#    Without the flag, the shell handler is disabled at worker startup.
```

## Agent usage (OpenClaw / Hermes / Cursor / Codex)

Three-command pattern an agent can drive without shell archaeology:

```bash
# Start (returns PIDs + pid_file on stdout as JSON, then detaches)
voltmind jobs supervisor start --detach --json
# → {"event":"started","supervisor_pid":1234,"worker_pid":1235,"pid_file":"/Users/you/.voltmind/supervisor.pid"}

# Check health (machine-parseable JSON, no log scraping)
voltmind jobs supervisor status --json
# → {"running":true,"supervisor_pid":1234,"last_start":"2026-04-23T15:30:22Z","crashes_24h":0, ...}

# Stop cleanly (SIGTERM + 35s drain + SIGKILL fallback)
voltmind jobs supervisor stop
```

Every lifecycle event (spawn, crash, backoff, health warning, max-crashes,
shutdown) is also written to `${VOLTMIND_AUDIT_DIR:-~/.voltmind/audit}/supervisor-YYYY-Www.jsonl`
for historical inspection. `voltmind doctor` reads that file and surfaces
a `supervisor` check in its health report.

## Deployment: systemd

For long-running Linux VMs with shell access.

```bash
# Create the worker user if it doesn't exist.
sudo useradd --system --home "$VOLTMIND_WORKSPACE" --shell /usr/sbin/nologin voltmind \
  2>/dev/null || true
sudo mkdir -p "$VOLTMIND_WORKSPACE" && sudo chown voltmind:voltmind "$VOLTMIND_WORKSPACE"

# Install the env file (secrets stay out of the unit file).
sudo install -m 600 -o voltmind -g voltmind \
  docs/guides/minions-deployment-snippets/voltmind.env.example /etc/voltmind.env
sudoedit /etc/voltmind.env
# Fill in DATABASE_URL, optional VOLTMIND_ALLOW_SHELL_JOBS=1.

# Install the unit file, substituting /srv/voltmind → your workspace path.
sudo install -m 644 docs/guides/minions-deployment-snippets/systemd.service \
  /etc/systemd/system/voltmind-worker.service
sudo sed -i "s|/srv/voltmind|$VOLTMIND_WORKSPACE|g" \
  /etc/systemd/system/voltmind-worker.service

sudo systemctl daemon-reload
sudo systemctl enable --now voltmind-worker
sudo systemctl status voltmind-worker
journalctl -u voltmind-worker -n 50
```

The shipped unit file invokes `voltmind jobs supervisor` (not `voltmind jobs work`
directly) so you get two-layer supervision: systemd restarts the supervisor
on host reboot, supervisor restarts the worker on in-process crash.

`Restart=always` + `RestartSec=10s` handle the supervisor-level recovery.
The unit runs as unprivileged `voltmind` with `PrivateTmp`, `ProtectSystem=strict`,
and `ReadWritePaths=$VOLTMIND_WORKSPACE,$HOME/.voltmind` (for the PID file and
audit log). `LimitNOFILE=65535` covers Bun + Postgres pool + concurrent
LLM subagent calls without hitting the default 1024 cap.

## Deployment: Fly.io

```bash
# Merge the [processes] block from fly.toml.partial into your fly.toml.
cat docs/guides/minions-deployment-snippets/fly.toml.partial >> fly.toml
# Review + edit as needed.

# Set secrets (Fly handles restart on crash).
fly secrets set DATABASE_URL='postgres://…' VOLTMIND_ALLOW_SHELL_JOBS=1
```

The `[processes]` block runs `voltmind jobs supervisor` as PID 1. Fly
restarts the container on host failure; the supervisor restarts the
worker on in-process crash.

## Deployment: Render / Railway / Heroku

Drop [`Procfile`](./minions-deployment-snippets/Procfile) at the repo
root. The shipped Procfile calls `voltmind jobs supervisor`. Set
`DATABASE_URL` + optional `VOLTMIND_ALLOW_SHELL_JOBS=1` via the platform's
env UI or CLI.

## Deployment: inline `--follow` (no persistent worker)

For short deterministic scripts on a fixed schedule where you don't need
a persistent worker between runs. Each cron run brings its own temporary
worker. `--follow` starts one on the queue and blocks until the
just-submitted job reaches a terminal state (`completed` / `failed` /
`dead` / `cancelled`). 2-3 s startup overhead per job; negligible vs job
duration for scheduled work.

```bash
VOLTMIND_ALLOW_SHELL_JOBS=1 voltmind jobs submit shell \
  --queue nightly-enrich \
  --params "{\"cmd\":\"$VOLTMIND_BIN embed --stale\",\"cwd\":\"$VOLTMIND_WORKSPACE\"}" \
  --follow \
  --timeout-ms 600000
```

Replace `voltmind embed --stale` with whichever voltmind subcommand you're
scheduling (`sync`, `extract`, `orphans`, `doctor`, `check-backlinks`,
`lint`, `autopilot`). For strict single-job semantics on shared queues,
use a dedicated queue name like `nightly-enrich` above.

## Upgrading from an older deployment

### From `minion-watchdog.sh` (pre-v0.20)

Earlier versions of this guide shipped a 68-line bash watchdog
(`minion-watchdog.sh`). It's been replaced by `voltmind jobs supervisor`
which handles everything the script did, plus atomic PID locking,
structured audit events, queue-scoped health checks, and graceful
drain on SIGTERM.

**Migration:**

```bash
# 1. Stop and remove the old watchdog.
sudo kill $(head -n1 /tmp/voltmind-worker.pid) 2>/dev/null
sudo rm -f /usr/local/bin/minion-watchdog.sh /tmp/voltmind-worker.pid \
           /tmp/voltmind-worker.log
crontab -e   # delete the "*/5 * * * * /usr/local/bin/minion-watchdog.sh" line

# 2. Start the supervisor (systemd users: reinstall the unit from
#    docs/guides/minions-deployment-snippets/systemd.service, which
#    now calls `voltmind jobs supervisor`).
voltmind jobs supervisor start --detach --json
# Or: sudo systemctl restart voltmind-worker

# 3. Verify.
voltmind jobs supervisor status --json
voltmind doctor   # 'supervisor' check should report running=true
```

### Schema / migration hygiene

Regardless of which deployment path you're upgrading from:

1. **Stop the worker before upgrading.** `voltmind jobs supervisor stop`
   (or `sudo systemctl stop voltmind-worker`). Skipping this risks an
   in-flight job landing partial schema.
2. **Run `voltmind upgrade`**. Then `voltmind apply-migrations --yes` if
   `voltmind doctor` reports any migration as `partial` or `pending`.
3. **If you run shell jobs:** from v0.14 onward, pass
   `--allow-shell-jobs` to the supervisor (or keep
   `VOLTMIND_ALLOW_SHELL_JOBS=1` in `/etc/voltmind.env`). Submitters don't
   need the flag; only the worker does.
4. **Verify.** `voltmind doctor` should report zero `pending` or `partial`
   migrations plus a healthy `supervisor` check. `voltmind jobs stats`
   should show no unexplained growth in `dead` between pre- and
   post-upgrade.

## Known issues

### Supabase connection drops

The worker uses a single Postgres connection. If Supabase drops it
(maintenance, connection limits, network blip), lock renewal fails
silently. The stall detector then dead-letters the job after
`max_stalled` misses.

**Current defaults that make this worse:**

- `lockDuration: 30000` (30 s) — too short for long jobs during
  connection blips.
- `max_stalled: 5` (schema column default — see `src/schema.sql` and
  `src/core/pglite-schema.ts`). Five missed heartbeats before dead-letter.
- `stalledInterval: 30000` (30 s) — checks too aggressively.

**Tune per-job today.** `voltmind jobs submit` accepts `--max-stalled N`,
`--backoff-type fixed|exponential`, `--backoff-delay <ms>`,
`--backoff-jitter 0..1`, and `--timeout-ms N` as first-class flags
(since v0.13.1). These write onto the job row at submit time — which is
what `handleStalled()` reads — so per-job tuning is the real knob today.

### DO NOT pass `maxStalledCount` to `MinionWorker`

It's a no-op. The stall detector reads the row's `max_stalled` column
(set at submit time), not the worker opt in `src/core/minions/worker.ts:74`.
Use `voltmind jobs submit --max-stalled N` per-job instead.

### Zombie shell children

When the Bun worker crashes hard, child processes from shell jobs can
become zombies. The supervisor's SIGTERM → 35s drain → SIGKILL window
covers the shell handler's 5 s child-kill grace (`KILL_GRACE_MS`). For
long-running shell jobs, prefer timeouts via `--timeout-ms` on submit
over relying on hard kills.

## Smoke test

```bash
# Supervisor alive?
voltmind jobs supervisor status --json | jq .running

# Aggregate queue health.
voltmind jobs stats

# Jobs currently stalled (still `active` with expired lock_until, pre-requeue).
voltmind jobs list --status active --limit 10

# Dead-lettered jobs.
voltmind jobs list --status dead --limit 10

# Shell handler registered? (check supervisor audit log or worker stderr.)
voltmind jobs supervisor status --json | jq '.worker_config.allow_shell_jobs'
```

## Uninstall

**`voltmind jobs supervisor`** (foreground or `--detach`):

```bash
voltmind jobs supervisor stop
```

**systemd:**

```bash
sudo systemctl disable --now voltmind-worker
sudo rm /etc/systemd/system/voltmind-worker.service /etc/voltmind.env
sudo systemctl daemon-reload
```

**Fly / Render / Railway:** delete the `worker` process from `fly.toml`
/ `Procfile` and redeploy. Secrets set via `fly secrets` persist until
`fly secrets unset`.

**Inline `--follow`:** remove the cron entry. Nothing else to clean up
— temporary workers exit with their jobs.
