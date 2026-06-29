# Agents working on VoltMind

This is the install and operating protocol for the VoltMind MVP runtime.
Claude Code also reads `./CLAUDE.md`; other agents should start here.

VoltMind is currently a local-first MVP. Treat PGLite as the supported storage
path, keep the public runtime surface small, and do not route users into
inherited GBrain advanced features unless a later phase explicitly re-enables
them.

## Install

1. Install Bun if needed:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   export PATH="$HOME/.bun/bin:$PATH"
   ```

2. Install VoltMind through Bun.

   From the GitHub repo, once the repo is reachable to the operator:
   ```bash
   bun install -g github:Justike001/voltmind
   voltmind --help
   ```

   Deterministic local/dev install:
   ```bash
   git clone https://github.com/Justike001/voltmind.git ~/voltmind
   cd ~/voltmind
   bun install
   bun link
   voltmind --help
   ```

   Local development without linking:
   ```bash
   bun run src/cli.ts --help
   bun run src/cli.ts init
   ```

3. Init the MVP brain:
   ```bash
   voltmind init
   ```

   MVP storage policy: use PGLite under `VOLTMIND_HOME` / `~/.voltmind`.
   Do not prompt users into Supabase/Postgres, multi-machine sync, or search-mode
   cost matrices in this phase.

4. Verify the install:
   ```bash
   voltmind status
   voltmind health
   voltmind doctor --fast
   ```

## Read this order

1. `./AGENTS.md` (this file) - install and operating protocol.
2. [`./CLAUDE.md`](./CLAUDE.md) - architecture reference, key files, trust boundaries,
   and test layout.
3. [`./docs/architecture/brains-and-sources.md`](./docs/architecture/brains-and-sources.md)
   - the two-axis mental model (brain = which DB, source = which repo in the DB).
   In the MVP, the supported brain is the local PGLite brain, but source routing
   still matters.
4. [`./skills/conventions/brain-routing.md`](./skills/conventions/brain-routing.md)
   - agent-facing decision table for brain/source routing. Apply only the parts
   compatible with the MVP public surface.
5. [`./skills/RESOLVER.md`](./skills/RESOLVER.md) - skill dispatcher. Read before
   any task; update it next so skills stop routing to frozen GBrain features.

## MVP runtime surface

Public CLI/MCP entrypoints are intentionally small:

- Setup/runtime: `init`, `config`, `storage`, `providers`, `sources`, `status`,
  `doctor`, `apply-migrations`.
- Page CRUD: `get`, `put`, `delete`, `restore`, `list`.
- Ingestion: `import`, `capture`, `sync`, `embed`.
- Retrieval: `search`, `query`, `ask`.
- Basic graph: `tag`, `untag`, `tags`, `link`, `unlink`, `backlinks`, `graph`,
  `timeline`, `timeline-add`.
- MCP: `serve`, `serve --http`, `call`, `--tools-json`.
- Jobs: `jobs list`, `jobs get`, `jobs cancel`, `jobs stats`.
- Admin readouts: `stats`, `health`, `history`, `version`.

Inherited GBrain commands such as `agent`, `autopilot`, `dream`, `eval`,
`skillpack`, `skillify`, `think`, `recall`, `forget`, `onboard`, `schema`,
`founder`, `takes`, `transcripts`, code-intelligence commands, salience/anomaly
flows, publish/integrations/book-mirror, and advanced job worker/supervisor
flows are frozen outside the MVP public surface. The code may remain in the
repo, but agents should not advertise or call it.

## Trust boundary

VoltMind distinguishes trusted local CLI callers (`OperationContext.remote = false`,
set by `src/cli.ts`) from untrusted agent-facing callers (`remote = true`, set by
`src/mcp/server.ts` and HTTP MCP dispatch). Security-sensitive operations tighten
filesystem confinement when `remote = true` and default to strict behavior when unset.

If you are writing or reviewing an operation, consult:

- `src/core/operations.ts` for the canonical BrainEngine operation contract.
- `src/core/mvp-surface.ts` for the current public MVP allowlist.
- `src/mcp/dispatch.ts`, `src/mcp/server.ts`, and `src/mcp/http-transport.ts`
  for MCP exposure and remote-call behavior.

## Common tasks

- **Initialize local brain:** `voltmind init`
- **Capture content:** `voltmind capture "note text"` or
  `voltmind capture --file ./note.md --slug inbox/example`
- **Import markdown:** `voltmind import ./notes --no-embed`
- **Embed content:** `voltmind embed --stale`
- **Search:** `voltmind search "keyword"` or `voltmind query "question"`
- **Serve MCP:** `voltmind serve` for stdio or `voltmind serve --http --port 7331`
- **Launch Admin UI:** `$env:VOLTMIND_ADMIN_AUTO_LOGIN_LOCAL='1'; voltmind serve --http --port 7331` — opens `http://127.0.0.1:7331/admin` without bootstrap token. If a compatible local daemon is already running, `serve --http` uses daemon-backed DB access and does not acquire the PGLite lock itself; otherwise it owns PGLite directly. See daemon section below for coexistence rules.
- **Inspect tools:** `voltmind --tools-json`
- **Check providers:** `voltmind providers list`, `voltmind providers test`
- **Check health:** `voltmind status`, `voltmind doctor --fast`, `voltmind health`

## Sandbox operations

The Codex agent runtime runs inside a sandbox that enforces two independent
layers of restriction. Treat them separately:

**File-system layer** (solved by workdir policy): the sandbox permits reads
anywhere and writes under `E:\gbrain\VoltMind`. The user-facing setting
"workspace-write" is sufficient for file edits.

**Network layer** (must be handled explicitly): the sandbox blocks ALL outbound
HTTP/HTTPS/Socket connections at the container level regardless of the
file-system setting. This includes connections to `127.0.0.1` and `localhost`.
On top of the container-level block, the sandbox injects proxy environment
variables that route traffic to a black-hole port (`127.0.0.1:9`):

- `HTTPS_PROXY=http://127.0.0.1:9`
- `HTTP_PROXY=http://127.0.0.1:9`
- `ALL_PROXY=http://127.0.0.1:9`
- `GIT_HTTP_PROXY=http://127.0.0.1:9`
- `GIT_HTTPS_PROXY=http://127.0.0.1:9`
- `NO_PROXY=localhost,127.0.0.1,::1`
- `npm_config_offline=true`

### Required pattern for ANY network operation

Every command that touches the network (including `localhost` API calls to
`127.0.0.1:7331`, `git push/pull/clone`, `npm install`, `pip install`, and
`Invoke-WebRequest` / `Invoke-RestMethod`) MUST do TWO things:

1. Set `sandbox_permissions: "require_escalated"` with a brief `justification`.
2. Clear ALL seven proxy/offline variables in the same command invocation:

```powershell
$env:HTTPS_PROXY=''; $env:HTTP_PROXY=''; $env:ALL_PROXY='';
$env:GIT_HTTP_PROXY=''; $env:GIT_HTTPS_PROXY='';
$env:npm_config_offline='false';
$env:NO_PROXY='';
# then the actual network command
```

Clearing only `HTTP_PROXY` + `HTTPS_PROXY` is not enough — leaving
`GIT_HTTP_PROXY`, `GIT_HTTPS_PROXY`, or `ALL_PROXY` set will still route
the relevant traffic through the black-hole proxy and cause timeouts or
"connection refused" errors.

### Common sandbox failure symptoms

- `Invoke-RestMethod` / `Invoke-WebRequest` against `127.0.0.1:7331` returns
  `Unable to connect` or hangs with `Connection refused`.
- `git clone` / `git push` hangs for 30+ seconds then fails.
- `bun install` / `npm install` reports network errors even for local packages.
- CLI commands exiting with `Received: -1` — the sandbox blocks `Bun.spawn`
  for child processes (not a network issue; escalate spawn commands too).

### Local Admin API access

Accessing `http://127.0.0.1:7331/admin/api/*` from within the sandbox ALWAYS
requires escalation + proxy cleanup. If `serve` was started without
`VOLTMIND_ADMIN_AUTO_LOGIN_LOCAL=1`, the API returns `Admin authentication
required` — the agent cannot resolve this without the bootstrap token. The
preferred pattern is to start `serve` with auto-login before making API calls:

```powershell
$env:VOLTMIND_HOME='C:\Users\justike.liu'
$env:VOLTMIND_ADMIN_AUTO_LOGIN_LOCAL='1'
bun run src/cli.ts serve --http --port 7331
```

When the agent needs to both start `serve` and call its API in a single turn,
use a PowerShell background job so the server has time to bind:

```powershell
# In the agent command, with require_escalated + proxy cleanup:
$job = Start-Job -ScriptBlock {
  $env:VOLTMIND_HOME='C:\Users\justike.liu'
  $env:VOLTMIND_ADMIN_AUTO_LOGIN_LOCAL='1'
  Set-Location 'E:\gbrain\VoltMind'
  bun run src/cli.ts serve --http --port 7331 2>&1
}
Start-Sleep 8
# Now API calls work
```

### CLI vs serve lock conflict

When `voltmind serve --http` owns the PGLite lock, no other process
(including `voltmind status` or any CLI command) can access the brain
directly. Workarounds in order of preference:

1. Use Admin API endpoints instead of CLI commands (the API shares the
   serve process's engine).
2. Start the daemon (`voltmind daemon start`) and stop serve — CLI commands
   then forward to the daemon automatically.
3. Stop serve, run CLI commands, restart serve (disruptive; only for bulk
   operations that have no API equivalent).

Do NOT run `voltmind storage unlock-pglite` while serve is alive; that removes
the lock file but leaves the serve process writing to the same database,
risking corruption.

## Personal brain scaffold language

The scaffold contract lives in `docs/drafts/personal-brain-scaffold/templates/`,
`brain/templates/`, and the runtime fallback in `src/core/personal-brain-scaffold.ts`.
Keep template headings and frontmatter keys stable. The body guidance under those
headings should be UTF-8 Chinese by default. Do not make AGENTS.md the only
place that defines page template wording.

## People page signal hygiene

When creating or updating `people/` pages, keep the section boundaries strict:

- `Ownership And Expertise` is for durable routing knowledge only: long-term
  ownership domains, systems, customers, workflows, institutional context, and
  which questions/reviews/decisions should route to this person. Do not put
  active projects, action items, temporary coordination, tool tips, social
  chatter, birthday/team-building chat, API-key logistics, OA/admin errands, or
  one-off Teams remarks here. Do not create graph links from this section unless
  the linked entity is part of durable ownership or expertise.
- `Current Work` is where active projects, actions, current delivery scope,
  current process ownership, and short-term work dependencies belong.
- `Open Threads` is only for unresolved commitments, risks, decisions, and
  questions that still need follow-up. If the same source already answers a
  question, do not write it under `Questions`; either omit it or summarize the
  resolved fact in the correct section with citation.
- Low-signal Teams/Email/Calendar material should stay in the source or
  conversation page unless it changes durable context. A person page is not a
  chat digest.

## Phase C-D-E agent protocol

This repository has been translated from inherited GBrain operator notes to the
VoltMind MVP runtime. Use `voltmind`, `VOLTMIND_HOME`, `.voltmind-source`, and
`voltmind.yml`; do not inject `gbrain`, `GBRAIN_*`, `.gbrain`, or `gbrain.yml`
instructions into agent context.

### Phase C.5: Windows/PGLite migrations and jobs visibility

For the Windows local-first MVP, run the idempotent migration runner and inspect
the runtime/job state:

```bash
voltmind apply-migrations --yes
voltmind status
voltmind health
voltmind jobs stats
```

PGLite is a single-process embedded database. Do not run DB-backed VoltMind CLI
commands in parallel against the same `VOLTMIND_HOME`; serialize `status`,
`health`, `config show`, `sources list`, `get`, `search`, `query`, `import`,
`sync`, and `embed` checks. If a command times out waiting for the PGLite lock,
inspect it before deleting anything:

```bash
voltmind storage pglite-lock
voltmind storage unlock-pglite --stale-only
```

`VOLTMIND_PGLITE_LOCK_TIMEOUT_MS` controls how long a CLI waits for the file
lock. `VOLTMIND_PGLITE_STALE_MS` controls when a lock is considered stale; raise
it explicitly for long `import`/`embed` runs.

The preferred coexistence model is: exactly one process owns PGLite, and
everyone else talks to that owner over local authenticated RPC. When a compatible
local daemon is already running, the daemon owns the PGLite lock. CLI commands,
`serve --http`, stdio MCP serve, Admin/OAuth readouts, MCP tool execution, and
webhook job submission should route DB work through the daemon instead of
opening PGLite directly.

`serve` intentionally remains `CLI_ONLY`; do not add it to
`LOCAL_DAEMON_COMMANDS`. It must keep hosting its own HTTP/Admin/OAuth/MCP
surface, while borrowing daemon DB execution through the daemon protocol v2
structured RPC calls.

**Mode A: daemon-backed Admin UI (recommended when CLI and browser sessions share one brain)**
Start the daemon first, then start `serve --http`. The serve process should log
that it is using the local daemon for DB access and should not acquire the
PGLite lock itself.

```bash
voltmind daemon start
$env:VOLTMIND_ADMIN_AUTO_LOGIN_LOCAL='1'
voltmind serve --http --port 7331
# Admin dashboard: http://127.0.0.1:7331/admin
```

When daemon-backed mode is active:

- CLI commands keep forwarding to the daemon automatically.
- `serve --http` owns the public HTTP/Admin/OAuth/MCP surface, but DB work runs
  in the daemon.
- HTTP MCP auth, scope checks, and request logging stay in `serve-http.ts`.
- Actual MCP operation execution runs through daemon RPC `tool_call`.
- Webhook/ingest/sync job submission runs through daemon RPC `queue_add`, so
  `MinionQueue.add()` keeps its transaction semantics inside the daemon.
- Admin/OAuth readouts that need SQL use daemon RPC `raw_sql`.

The daemon protocol v2 is local-only: `127.0.0.1` plus the state-file bearer
token. Structured daemon RPC kinds are `tool_call`, `raw_sql`, `engine_stats`,
`engine_health`, and `queue_add`. `raw_sql` is for trusted local
daemon-authenticated callers only; never expose it through public MCP.

If `serve` finds a live daemon that is too old for protocol v2, it should refuse
to start with restart guidance. Restart the daemon with the same build, then
start serve again:

```bash
voltmind daemon stop
voltmind daemon start
voltmind serve --http --port 7331
```

Do not work around an incompatible live daemon by starting direct serve; the old
daemon may still be holding the PGLite lock. Restart it cleanly instead.

`VOLTMIND_DAEMON_BYPASS=1` is an explicit debugging escape hatch. It disables
daemon-backed serve detection and makes `serve` try direct PGLite access. Use it
only when intentionally testing direct-engine behavior and after checking that no
other process owns the brain.

**Mode B: direct Admin UI (no daemon running)**
If no local daemon is running, `serve --http` keeps the historical behavior and
owns PGLite directly:

```bash
$env:VOLTMIND_ADMIN_AUTO_LOGIN_LOCAL='1'
voltmind serve --http --port 7331
# Admin dashboard: http://127.0.0.1:7331/admin
```

While direct serve owns PGLite, do not run DB-backed direct CLI commands in
parallel against the same `VOLTMIND_HOME`. Either use the Admin UI/MCP surface,
or stop direct serve cleanly before starting the daemon.

**Mode C: CLI daemon (terminal-only sessions)**
Start the background daemon, then all core CLI commands forward to it
automatically. Browser UI can be added later by starting `serve --http` in
daemon-backed mode.

```bash
voltmind daemon start
voltmind daemon status
voltmind daemon stop
```

When the daemon is running, these commands forward to it: `get`, `list`,
`search`, `query`, `stats`, `health`, `import`, `embed`, `status`, `config`,
`sources`, `capture`, `sync`, `tag`, `link`, `timeline-add`, `actions`,
and their variants. Use `VOLTMIND_DAEMON_BYPASS=1` only for debugging
direct PGLite CLI access.

**If you see "Timed out waiting for PGLite lock"**
Do NOT kill processes blindly. Check what's already running first:

```bash
voltmind daemon status
netstat -ano | Select-String "7331|3131"
```

If the daemon is running and protocol v2 compatible, start or use
`serve --http` normally so it routes through the daemon. If direct
`serve --http` is already serving the admin and owns PGLite, use that Admin UI
or stop it cleanly before starting the daemon. Avoid deleting locks or killing
processes until you know which process owns the brain.

Do not run `voltmind autopilot --install` on Windows/PGLite. The inherited
autopilot installer only has macOS launchd, Linux systemd, ephemeral-container,
and Linux crontab targets; it does not install a Windows service. PGLite also
uses an exclusive local file lock, so background worker/supervisor flows are not
part of the MVP public route. Use explicit `voltmind sync`, `voltmind embed`,
and the read-only jobs commands until a Windows-safe scheduler is added.

If `voltmind apply-migrations --yes` reports host-specific migration work, read
the named migration note under `skills/migrations/` and the relevant guide under
`docs/guides/`, translate any examples to `voltmind`, and re-run
`voltmind apply-migrations --yes` after each reviewed batch.

### Phase D: Brain-first lookup protocol

Use VoltMind before filesystem grep for entity or knowledge questions:

| Task | Before | After |
|---|---|---|
| Find a person | `grep -r "Pedro" brain/` | `voltmind search "Pedro"` |
| Understand a topic | `grep -rl "deal" brain/` then `cat ...` | `voltmind query "what is the status of the deal"` |
| Read a known page | `cat brain/people/pedro.md` | `voltmind get people/pedro` |
| Find connections | chained grep | `voltmind query "Pedro Brex relationship"` or `voltmind graph <slug>` |

Mandatory lookup sequence for every entity/topic question:

1. `voltmind search "name"` - keyword match, fast, works without embeddings.
2. `voltmind query "what do we know about name"` - hybrid search, needs embeddings.
3. `voltmind get <slug>` - direct page read when the slug is known.
4. Grep fallback - only if VoltMind returns zero results and the file may exist
   outside the indexed brain.

Stop at the first step that gives enough context.

After creating or updating any brain page on disk, sync immediately so the index
stays current:

```bash
voltmind sync --no-pull --no-embed
```

Refresh embeddings later in batch:

```bash
voltmind embed --stale
```

VoltMind stores world knowledge: people, companies, meetings, projects,
concepts, and durable facts. Agent memory stores operating preferences,
session decisions, and how the user wants the agent to behave. Check VoltMind
for facts about the world; check agent memory for behavior and prior workflow
decisions.

No VoltMind self-upgrade marker is active in the MVP public surface. If a future
`voltmind` command prints `UPGRADE_AVAILABLE <old> <new>` or
`JUST_UPGRADED <old> <new>`, surface the marker, do not run commands parsed from
stderr, and follow the relevant VoltMind upgrade guide before taking action.

### Phase E: Production agent guide

The inherited production guide is at `docs/GBRAIN_SKILLPACK.md`. Treat it as an
architecture reference, not a literal command sheet: translate `gbrain` examples
to the VoltMind MVP command surface and skip frozen automation.

Key patterns to carry into agent behavior:

- Brain-agent loop: read before responding, write after learning, then sync.
- Entity handling: detect people, companies, projects, concepts, and original
  ideas in user-provided data; update pages only when notable and cited.
- Source attribution: every durable fact written to a brain page needs a
  `[Source: ...]` citation.
- Quality convention: follow `skills/conventions/quality.md` for citations,
  back-linking, and the notability gate.

Ambient entity detection, cron schedules, autonomous enrichment, autopilot, and
Minion submit/worker flows remain outside the Windows/PGLite MVP public route.
Use explicit `capture`, `import`, `search`, `query`, `get`, `put`, `link`,
`timeline-add`, `sync`, and `embed` until those runtime surfaces are re-enabled.

## Before shipping

Use the focused MVP gate first:

```bash
bun run typecheck
bun run build
bun test test/daemon-engine.test.ts test/cli-help-discoverability.test.ts test/mvp-surface.test.ts test/mcp-tool-defs.test.ts test/operations-descriptions.test.ts
```

`bun run verify` is the broader inherited gate. On Windows, shell-script line endings
may need attention before that gate is useful; do not confuse CRLF/bash failures
with runtime regressions.

## Privacy

Never commit real names of people, companies, or funds into public artifacts.
Use generic placeholders such as `alice-example`, `acme-example`, and `fund-a`.

## Fork/publish notes

If publishing from a fork, regenerate public docs and hosted URLs with the VoltMind
repo base:

```bash
LLMS_REPO_BASE=https://raw.githubusercontent.com/Justike001/voltmind/master bun run build:llms
```
