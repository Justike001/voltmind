---
name: setup
description: Set up VoltMind as a thin client connected to the company brain Host over MCP (OAuth 2.1), agent instructions, first retrieval, and thin-client shared-drive roots. Use for first connect to the Host's MCP server, or for configuring RaiDrive/SMB/Z-drive mappings on a client workstation.
triggers:
  - "set up voltmind"
  - "initialize brain"
  - "voltmind setup"
  - "configure shared drive"
  - "configure raidrive"
  - "map z drive"
  - "配置共享盘"
  - "映射 z 盘"
tools:
  - get_stats
  - get_health
  - sync_brain
  - put_page
  - search_file_refs
  - backfill_file_refs
  - scrub_file_ref_open_paths
mutating: true
---

# Setup VoltMind

Set up VoltMind from scratch. Target: working brain in under 5 minutes.

## Contract

- Setup completes with a working brain verified by `voltmind doctor --json` (all checks OK).
- The brain-first lookup protocol is injected into the project's AGENTS.md or equivalent.
- Live sync is configured and verified (a test change pushed and found via search).
- Schema state is tracked in `~/.voltmind/update-state.json` so future upgrades know what the user adopted or declined.
- No Supabase anon key or cloud database is requested. As a thin client you connect to the Host's MCP server with OAuth credentials; the Host owns the database.
- For a company environment that requires embedding/reranking data to stay
  internal, use [`docs/ai-providers/qwen-vllm.md`](../../docs/ai-providers/qwen-vllm.md)
  before initialization. It defines the required Qwen `halfvec(2048)` schema
  and internal endpoint configuration; do not substitute a public embedding
  provider for that workflow.

## How you connect: MCP to the Host (thin client)

The VoltMind brain already runs **on the company brain Host** (an Ubuntu server).
You do NOT stand up your own Postgres/Supabase. Your machine or agent is a
**thin client**: it connects to the Host's MCP server over HTTPS with OAuth 2.1,
and the Host owns all retrieval, writes, sync, and embeddings. Brain data never
leaves the Host.

- **Ingress (issuer):** `https://<host-public-url>` (e.g. `https://<host>.ts.net`)
- **MCP endpoint:** `<issuer>/mcp` (e.g. `https://<host>.ts.net/mcp`)
- **Auth:** OAuth 2.1 (`client_credentials`, or annotated PKCE for browser clients)
- **OAuth discovery:** `<issuer>/.well-known/oauth-authorization-server`
- **Routable from a thin client:** `search`, `query`, `stats`, `doctor --json`,
  page reads/writes, and — if the Host enables `mcp.publish_skills=true` —
  `list_skills` / `get_skill`, so you can read THIS skill live from the Host.
- **Host-only (never run on the thin client):** `sync`, `embed`, `extract`,
  `sources`/file management, `serve`, migrations. Thin clients are refused these
  and pointed at the Host; the Host's agent runs them on the server.

The Host operator (or the Host's own agent — see "Automated provisioning" in
Phase A) issues your `client_id` / `client_secret` and binds you to a **source**
(which repo inside the brain). You never see a database connection string or a
Supabase key — those never leave the Host.

## Prerequisites (on your side)

- The `voltmind` binary installed on your machine/agent.
- Host-issued OAuth credentials:
  - `--issuer-url https://<host-public-url>` (or `VOLTMIND_REMOTE_ISSUER_URL`)
  - `--mcp-url https://<host-public-url>/mcp` (or `VOLTMIND_REMOTE_MCP_URL`)
  - `--oauth-client-id <id>` / `--oauth-client-secret <s>` (or `VOLTMIND_REMOTE_CLIENT_ID` / `VOLTMIND_REMOTE_CLIENT_SECRET`)
- A target **source id** assigned by the Host (e.g. `personal-alice-example`).
- Network reachability to the Host (HTTPS outbound).

## Available init options (thin client)

- `voltmind init --mcp-only --issuer-url <u> --mcp-url <u>/mcp --oauth-client-id <id> --oauth-client-secret <s>`
  -- writes a `remote_mcp` config, creates **no** local engine, and runs three
  pre-flight smokes (OAuth discovery → token round-trip → MCP initialize).
- `voltmind init --mcp-only --force` -- re-run / refresh an existing thin-client config.
- `voltmind doctor --json` -- post-connect health check (OAuth + MCP checks).
- `voltmind remote ping` -- ask the Host to run a sync/embed cycle (thin-client friendly).

Not a thin client? A machine that will run its OWN engine uses **Phase B** instead.

## Thin-client shared-drive roots

Configure mapped drives on each client workstation after `init --mcp-only`.
These commands are CLI-local and must not run on the Host:

```powershell
voltmind client-roots add synology-public `
  --local-root 'Z:\' `
  --unc-root '\\RaiDrive-CurrentUser\Synology'
voltmind client-roots test synology-public
```

Every workstation uses the same `root_key` but may use a different drive letter
or RaiDrive username. If the agent cannot execute a shell on that workstation,
return the commands for the user to run. Verify retrieval with
`voltmind file-refs search '<local-path>'`; the Host stores only the logical
root/path identity.

## Phase A: Connect to the Host via MCP (recommended)

1. Confirm which Host brain + source the user belongs to, and that the Host's MCP
   server is reachable:
   ```bash
   curl -sI https://<host-public-url>/mcp          # expect 200/204
   curl -s  https://<host-public-url>/.well-known/oauth-authorization-server
   ```
2. Collect your Host-issued credentials. **No manual Host work needed** if the
   Host operator has run the automated provisioning bootstrap (see below).
3. Connect as a thin client (this runs the three pre-flight smokes automatically):
   ```bash
   voltmind init --mcp-only \
     --issuer-url https://<host-public-url> \
     --mcp-url https://<host-public-url>/mcp \
     --oauth-client-id <client-id> \
     --oauth-client-secret <client-secret>
   ```
   Expected: `✓ OAuth discovery`, `✓ OAuth /token`, `✓ MCP initialize`. If any
   step fails, stop and report it (see "Error Recovery").
4. Verify the connection:
   ```bash
   voltmind doctor --json
   ```
   Report the full JSON; every check should be OK.
5. Basic test — prove retrieval works end-to-end through the MCP connection:
   ```bash
   voltmind search "<a topic you know is in the brain>"
   voltmind query "what do we know about <topic>"
   voltmind stats
   ```
6. (Optional) Pull this skill live from the Host instead of trusting a local copy:
   once `mcp.publish_skills=true`, call `list_skills` then `get_skill setup`.

**Automated provisioning (removes the manual Host brace):** the Host operator runs a
one-time bootstrap that (a) ensures your source exists and (b) registers an OAuth
client bound to it (`--source <id> --scopes read write`), then hands you
`client_id`/`client_secret`. After that, connecting + testing is fully self-service.
The exact command list lives in `docs/mcp/DEPLOY.md`.

## Phase A.5: Onboard a user's personal knowledge base (email → source + Gogs repo)

For each user, the **personal KB** lives in its own isolated DB source. Company
email is the identity contract:
- `alice-example@company.example` → a readable collision-resistant source id such as
  `personal-alice-<digest>`.
- **One company email always maps to exactly ONE source** (deterministic dedup) —
  re-provisioning never creates a second source, keeping per-user KBs manageable.
- **Scope isolation:** the minted credential can only read/write that user's own
  source; other users' sources are unreachable.

### Step 1 — user (or their agent) creates their Gogs account + knowledge repo
Most users aren't developers, so the user's agent does this for them against the
company Gogs `https://gogs.internal.example` (org: `https://gogs.internal.example/example-org`):
1. Create a Gogs account (username from the email local part, e.g. `alice-example`).
2. Under the `example-org` org, create an empty personal knowledge repo, e.g.
   `https://gogs.internal.example/example-org/alice-example-kb`.
3. Add an initial commit (e.g. a `README.md`) so the Host can clone it.

### Step 2 — provision (Host operator / Host agent)
One command (or one admin call) creates the DB source, checks out the repo, and
mints a source-scoped credential. The repo can be cloned over **HTTPS** or over
**SSH** using the Host's Gogs-admin SSH key (sees every member's private repo):
```bash
# The USER's agent creates the repo in Gogs, then hands its SSH address over.
# The HOST agent clones it (SSH checkout) and syncs with the Host key.

# CLI, on the Host (admin / Host agent): SSH checkout
voltmind provision-personal alice-example@company.example \
  --repo-url git@gogs.internal.example:example-org/alice-example-kb.git
#   --allow-ssh auto-detected for ssh:// / git@host:path forms

# admin HTTP endpoint (bootstrap token):
curl -X POST https://<host>/admin/api/provision-personal-source \
  -H "Authorization: Bearer <bootstrap-token>" -H "Content-Type: application/json" \
  -d '{"email":"alice-example@company.example","repoUrl":"git@gogs.internal.example:example-org/alice-example-kb.git"}'

# MCP op (admin scope):
#   provision_personal_source { email, repo_url, scopes:"read write" }
```
Returns `source_id` + `client_id`/`client_secret`.

> **SSH key security boundary (admin-only):** the Host's Gogs-admin SSH key is used
> ONLY by the Host to checkout/sync users' private repos — that's why the user's
> agent passes the repo's SSH address, and the Host (not the user) runs the clone.
> SSH checkout is an **admin-privilege** capability: it is honored only for an
> `admin`-scope caller (the Host agent / operator) or the bootstrap-token admin
> endpoint / local CLI. Non-admin users cannot invoke it (they lack `admin` scope
> and never reach `provision_personal_source`). As an extra guard the key is
> **confined to the company Gogs host** (`VOLTMIND_GOGS_SSH_HOST`, default
> `gogs.internal.example`) — so even an admin can't point it at arbitrary internal hosts.

> **Private/internal Gogs (important):**
> - **SSH checkout (recommended for private repos):** the Host clones with the
>   Gogs-admin key via `GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"`
>   — no password in any URL, key must be on the Host (`~/.ssh`) and its
>   `git@gogs.internal.example:~` confirmation accepted once.
> - **HTTPS checkout:** only accepts `https://` and rejects internal networks
>   unless the Host runs with `VOLTMIND_ALLOW_PRIVATE_REMOTES=1`; embedded
>   `user:pass@host` credentials are always blocked.
> - Hosts talking to the private `gogs.internal.example` Gogs should set
>   `VOLTMIND_ALLOW_PRIVATE_REMOTES=1` regardless (the IP is a private net).

### Step 3 — user connects as a thin client (self-serve)
```bash
voltmind init --mcp-only \
  --issuer-url https://<host-public-url> \
  --mcp-url https://<host-public-url>/mcp \
  --oauth-client-id <client_id> --oauth-client-secret <client_secret>
voltmind doctor --json
voltmind search "<topic>"
```
From here the user reads/writes only their own `personal-*` source; other users'
sources stay unreachable.

## Phase B: Standalone VoltMind (alternative)

Only for a machine that runs its OWN engine (not a thin client) — e.g. a personal
brain or an isolated Host. The company default is connecting to the Host (Phase A).

1. Have any Postgres with pgvector ready (self-hosted, Neon, Railway, managed
   PgBouncer pooler, etc.). Prefer the Transaction pooler string (port 6543) over
   a direct IPv6-only host where applicable.
2. Run: `voltmind init --non-interactive --url "<connection_string>"`
3. Verify: `voltmind doctor --json`
4. Live sync, embeddings, and autopilot then run on THIS machine (Phase H).

## Phase C: First Import

> **Thin client:** imports run on the Host, not your machine. If you connected via
> Phase A, skip to the retrieval verification below, or ask the Host's agent to run
> the import. The rest of Phase C is for a Host operator with a local engine (Phase B).

1. **Discover markdown repos.** Scan the environment for git repos with markdown content.

On macOS/Linux:

```bash
echo "=== VoltMind Environment Discovery ==="
for dir in /data/* ~/git/* ~/Documents/* 2>/dev/null; do
  if [ -d "$dir/.git" ]; then
    md_count=$(find "$dir" -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$md_count" -gt 10 ]; then
      total_size=$(du -sh "$dir" 2>/dev/null | cut -f1)
      echo "  $dir ($total_size, $md_count .md files)"
    fi
  fi
done
echo "=== Discovery Complete ==="
```

On Windows PowerShell, use the equivalent scan below. Adjust `$roots` when your
repositories live elsewhere:

```powershell
Write-Host "=== VoltMind Environment Discovery ==="
$roots = @(
  (Join-Path $env:USERPROFILE "git"),
  (Join-Path $env:USERPROFILE "Documents"),
  (Join-Path $env:USERPROFILE "source")
) | Where-Object { Test-Path -LiteralPath $_ }

$repos = foreach ($root in $roots) {
  Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName ".git") }
}

foreach ($repo in $repos) {
  $mdFiles = @(Get-ChildItem -LiteralPath $repo.FullName -Recurse -File -Filter "*.md" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch "[\\/](node_modules|\.git)[\\/]" })
  if ($mdFiles.Count -gt 10) {
    $allFiles = @(Get-ChildItem -LiteralPath $repo.FullName -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch "[\\/]\.git[\\/]" })
    $totalBytes = ($allFiles | Measure-Object -Property Length -Sum).Sum
    $totalSize = "{0:N1} MB" -f ($totalBytes / 1MB)
    Write-Host ("  {0} ({1}, {2} .md files)" -f $repo.FullName, $totalSize, $mdFiles.Count)
  }
}
Write-Host "=== Discovery Complete ==="
```

2. **Import the best candidate.** For large imports (>1000 files), run the
   import in a detached process so it survives the current terminal session.
   On macOS/Linux, use `nohup`:
   ```bash
   nohup voltmind import <dir> --no-embed --workers 4 > /tmp/voltmind-import.log 2>&1 &
   ```
   Check progress with: `tail -1 /tmp/voltmind-import.log`

   On Windows PowerShell, use `Start-Process` with separate stdout/stderr logs:
   ```powershell
   $log = Join-Path $env:TEMP "voltmind-import.log"
   $err = Join-Path $env:TEMP "voltmind-import.err.log"
   $proc = Start-Process -FilePath "voltmind" `
     -ArgumentList @("import", "<dir>", "--no-embed", "--workers", "4") `
     -RedirectStandardOutput $log -RedirectStandardError $err -PassThru
   $proc.Id
   Get-Content -Path $log -Tail 1
   Get-Content -Path $err -Tail 1
   ```
   Check progress again with `Get-Content -Path $log -Tail 1` and inspect
   `$err` if the process exits unexpectedly. To stop it, use
   `Stop-Process -Id <pid>`.

   For smaller imports, run directly:
   ```bash
   voltmind import <dir> --no-embed
   ```
   The same direct command works in PowerShell:
   ```powershell
   voltmind import <dir> --no-embed
   ```

3. **Prove search works.** Pick a semantic query based on what you imported:
   ```bash
   voltmind search "<topic from the imported data>"
   ```
   This is the magical moment: the user sees search finding things grep couldn't.

4. **Start embeddings.** Refresh stale embeddings (runs in background). Keyword
   search works NOW, semantic search improves as embeddings complete.

5. **Backfill the knowledge graph.** Populate typed links and structured timeline
   from the imported pages. Auto-link maintains both going forward, but historical
   pages need a one-time backfill.

   ```bash
   voltmind extract links --source db --dry-run | head -20    # preview
   voltmind extract links --source db                         # commit
   voltmind extract timeline --source db                      # dated events
   voltmind stats                                             # verify links > 0
   ```

   After this, `voltmind graph-query <slug> --depth 2` works and search ranks
   well-connected entities higher. Idempotent — safe to re-run anytime.
   Supports `--since YYYY-MM-DD` for incremental runs on huge brains.

   Skip if Phase C imported zero pages (auto-link handles new writes).

6. **Offer file migration.** If the repo has binary files (.raw/ directories with
   images, PDFs, audio):
   > "You have N binary files (X GB) in your brain repo. Want to move them to cloud
   > storage? Your git repo will drop from X GB to Y MB. All links keep working."

   If the user agrees, configure storage and run migration:
   ```bash
   # Configure storage backend (Supabase Storage recommended)
   voltmind config set storage.backend supabase
   voltmind config set storage.bucket brain-files
   voltmind config set storage.projectUrl <supabase-url>
   voltmind config set storage.serviceRoleKey <service-role-key>

   # Migrate binary files to cloud (3-step lifecycle)
   voltmind files mirror <brain-dir>       # Upload to cloud, keep local
   voltmind files redirect <brain-dir>     # Replace local with .redirect.yaml pointers
   # (optional) voltmind files clean <brain-dir> --yes   # Remove pointers too
   ```

   After migration, `voltmind files upload-raw` handles new files automatically:
   small text/PDFs stay in git, large/media files go to cloud with `.redirect.yaml`
   pointers. Files >= 100 MB use TUS resumable upload for reliability.

If no markdown repos are found, create a starter brain with a few template pages
(a person page, a company page, a concept page) from docs/VOLTMIND_RECOMMENDED_SCHEMA.md.

## Phase C.5: One-step autopilot + Minions install (v0.11.1+)

Windows, macOS, and Linux all use the same entry:

```bash
voltmind autopilot --install
```

`voltmind autopilot --install` is now a public MVP command (no
`VOLTMIND_INTERNAL_MIGRATION` flag needed). It detects the platform and
installs the right process manager, then runs the single platform-agnostic
`runAutopilot()` which supervises one Minions worker consuming the
Postgres/Supabase queue.

**Process manager differs by platform. Autopilot, ChildWorkerSupervisor,
Minion worker and Postgres queue are shared.**

Detect the platform first, or ask the user if you cannot determine it:

```bash
node -e "console.log(process.platform)"   # darwin -> macOS, linux -> Linux, win32 -> Windows
```

> If detection is inconclusive, ask the user:
> "What OS are you on — Windows, macOS, or Linux?"

### Windows

- Uses the **Task Scheduler** adapter. `win32` routes to `windows-task`
  (never falls back to `linux-cron`).
- **Requires Supabase/Postgres.** PGLite does not support a supervised
  Minion worker on Windows — install returns a clear, actionable error.
- Registers a user-level task (`VoltMind Autopilot`) that runs on logon
  with `LeastPrivilege`, `IgnoreNew` concurrency, restart-on-failure
  (1 min, up to 5 retries), and indefinite execution time.
- **Administrator PowerShell is not required by default.** The task uses the
  current user's `InteractiveToken` and `LeastPrivilege`; run the install from
  a normal PowerShell window first. If Task Scheduler returns `Access is
  denied`, a local policy blocks task registration, or the task service
  requires elevation, stop and ask the user to open **PowerShell as
  Administrator** and rerun the same install command themselves. Do not
  silently self-elevate or ask the model to bypass the user's UAC decision.
- The task action is plain `voltmind autopilot --repo <path>` — never
  `--no-worker` and never `jobs work` (only the allowed topology
  Task Scheduler → autopilot → supervised `jobs work`).
- Optional `--runtime-env-file <path>` loads allowlisted runtime secrets
  (Postgres/Supabase/provider keys) before engine init. Windows does NOT
  read `.zshrc`/`.bashrc` and does NOT generate a bash wrapper.
- Windows writes the Autopilot and supervised Minion stdout/stderr to the
  combined live log `%USERPROFILE%\.voltmind\runtime\autopilot.log` while
  preserving the native Task Scheduler → Autopilot → worker process tree. Tail
  it with `Get-Content "$env:USERPROFILE\.voltmind\runtime\autopilot.log" -Wait`.
- Recommended PowerShell install path:

  ```powershell
  voltmind apply-migrations --yes
  voltmind autopilot --install --repo <path>
  # Add --runtime-env-file <path> only when required secrets are not already
  # available through the VoltMind config file.
  ```

  If `sync.repo_path` is already configured, omit `--repo <path>`. This is
  the complete Windows install path: do not run `voltmind jobs work` as a
  second scheduled task, do not add `--no-worker`, and do not use WSL or
  PowerShell `Start-Job` as a substitute. The Task Scheduler task starts
  autopilot, and autopilot starts and supervises the Postgres Minions worker.
- Installation performs a readiness check after starting the task. Verify the
  result with:

  ```powershell
  voltmind autopilot --status --json
  voltmind jobs stats
  ```

  The expected state is `target: "windows-task"`, a registered/running
  scheduler entry, `autopilot: running`, and a ready Postgres worker. A task
  that is merely registered but has no ready worker is not a successful
  installation.
- Common Windows failures are actionable: a PGLite engine must be migrated to
  Supabase/Postgres first; a missing runtime env file must be corrected with
  `--runtime-env-file`; and a worker readiness failure should be diagnosed
  through the autopilot log and Supabase connectivity. Never work around these
  failures by switching to `--no-worker`, because that leaves dispatched jobs
  unconsumed.
- Runs after the user logs in. 24x7 across logoff/reboot is not currently
  guaranteed; rely on the Task Scheduler logon trigger.
- `voltmind autopilot --status --json` reports scheduler, autopilot,
  worker, and database readiness. `voltmind autopilot --uninstall` stops
  and deletes the task plus VoltMind-owned manifest/Task XML (never user
  repo/config/env/Supabase data).

### macOS

- Keeps the **launchd** path (`~/Library/LaunchAgents/com.voltmind.autopilot.plist`).

### Linux

- Keeps the **systemd / ephemeral-container / cron** paths. A Linux brain
  host uses the same `runAutopilot()` and `ChildWorkerSupervisor` and
  consumes the same Supabase/Postgres queue — no Windows-specific manifest,
  Task XML, or local paths enter the shared database.
- On Ubuntu/Linux, run only `voltmind autopilot --install` and let runtime
  detection choose `linux-systemd`, `ephemeral-container`, or `linux-cron`.
  Never pass `--target windows-task` and never set
  `VOLTMIND_AUTOPILOT_TARGET=windows-task`; the runtime rejects that target on
  non-Windows hosts.

### Install

```bash
voltmind apply-migrations --yes       # idempotent on healthy installs
voltmind autopilot --install          # supervises itself + forks the Minions worker; env-aware
```

What `voltmind autopilot --install` does:

- On **macOS**: writes a launchd plist at `~/Library/LaunchAgents/com.voltmind.autopilot.plist`.
- On **Linux with systemd**: writes `~/.config/systemd/user/voltmind-autopilot.service`
  with `Restart=on-failure`.
- On **ephemeral containers** (Render / Railway / Fly / Docker): writes
  `~/.voltmind/start-autopilot.sh` and prints the one-line your agent's
  bootstrap should source to launch autopilot on every container start.
  Auto-injects into OpenClaw's `hooks/bootstrap/ensure-services.sh` if
  detected (use `--no-inject` to opt out).
- On **Linux without systemd**: installs a crontab entry (every 5 min).
- On **Windows**: registers a Task Scheduler entry (`windows-task`) and
  starts it immediately.

Autopilot then supervises the Minions worker as a child process. Users get
sync + extract + embed + backlinks + durable Postgres-backed job processing
from ONE install step. No separate `voltmind jobs work` daemon to manage.

On PGLite, autopilot runs inline (PGLite's exclusive file lock blocks a
separate worker process). On Windows, PGLite install is refused — configure
Supabase/Postgres first. Everything else still works.

If `minion_mode=off`, the install still registers autopilot but reports a
**degraded** state (`autopilot: running, minion_worker: disabled_by_config,
queue_consumption: unavailable`) — it never silently overrides user config.

If `apply-migrations` prints "N host-specific items need your agent's
attention," read `~/.voltmind/migrations/pending-host-work.jsonl` + walk
`skills/migrations/v0.11.0.md` + `docs/guides/plugin-handlers.md` to
register host-specific handlers. Re-run `apply-migrations` after each
batch.

## Phase D: Brain-First Lookup Protocol

Inject the brain-first lookup protocol into the project's AGENTS.md (or equivalent).
This replaces grep-based knowledge lookups with structured voltmind queries.

### BEFORE (grep) vs AFTER (voltmind)

| Task | Before (grep) | After (voltmind) |
|------|---------------|-----------------|
| Find a person | `grep -r "Pedro" brain/` | `voltmind search "Pedro"` |
| Understand a topic | `grep -rl "deal" brain/ \| head -5 && cat ...` | `voltmind query "what's the status of the deal"` |
| Read a known page | `cat brain/people/pedro.md` | `voltmind get people/pedro` |
| Find connections | `grep -rl "Brex" brain/ \| xargs grep "Pedro"` | `voltmind query "Pedro Brex relationship"` |

### Lookup sequence (MANDATORY for every entity question)

1. `voltmind search "name"` -- keyword match, fast, works without embeddings
2. `voltmind query "what do we know about name"` -- hybrid search, needs embeddings
3. `voltmind get <slug>` -- direct page read when you know the slug from steps 1-2
4. `grep` fallback -- only if voltmind returns zero results AND the file may exist outside the indexed brain

Stop at the first step that gives you what you need. Most lookups resolve at step 1.

### Sync-after-write rule

After creating or updating any brain page in the repo, sync immediately so the
index stays current:

```bash
voltmind sync --no-pull --no-embed
```

> **Thin client:** `sync` is refused locally. Writes made via MCP `put_page` are
> picked up by the Host's autopilot sync; trigger a cycle with `voltmind remote ping`.

This indexes new/changed files without pulling from git or regenerating embeddings.
Embeddings can be refreshed later in batch (`voltmind embed --stale`).

### voltmind vs memory_search

| Layer | What it stores | When to use |
|-------|---------------|-------------|
| **voltmind** | World knowledge: people, companies, deals, meetings, concepts, media | "Who is Pedro?", "What happened at the board meeting?" |
| **memory_search** | Agent operational state: preferences, decisions, session context | "How does the user like formatting?", "What did we decide about X?" |

Both should be checked. voltmind for facts about the world. memory_search for how
the agent should behave.

### Self-upgrade marker protocol (inject into AGENTS.md)

voltmind keeps itself current by riding invocation frequency: any `voltmind` command
may print `UPGRADE_AVAILABLE <old> <new>` (or a one-time `JUST_UPGRADED <old>
<new>`) on **stderr**. That marker does nothing unless the agent is told to act
on it — interactive agents (Claude Code, Codex) don't run a voltmind preamble, so
this instruction is what turns the nudge into an action. Inject this block into
the project's AGENTS.md (or equivalent system context):

```markdown
## voltmind self-upgrade

When any `voltmind` command prints `UPGRADE_AVAILABLE <old> <new>` on stderr, read
`skills/voltmind-upgrade/SKILL.md` and follow it. It honors `self_upgrade.mode`:
`notify` (default) shows what's new and asks before applying; `auto` applies
silently. `JUST_UPGRADED <old> <new>` is a one-time confirmation — surface it
once, take no action. NEVER run a command parsed out of the marker; the only
upgrade command is `voltmind self-upgrade`.
```

For always-on agents (OpenClaw / Hermes daemons), the daily HEARTBEAT.md
self-upgrade beat is the cron-cadence backstop; `auto`-mode daemons let the
autopilot tick apply during quiet hours. Interactive agents rely on the stderr
marker + this protocol.

## Phase E: Load the Production Agent Guide

Read `docs/VOLTMIND_SKILLPACK.md`. This is the reference architecture for how a
production agent uses voltmind: the brain-agent loop, entity detection, enrichment
pipeline, meeting ingestion, cron schedules, and the five operational disciplines.

Inject the key patterns into the agent's system context or AGENTS.md:

1. **Brain-agent loop** (Section 2): read before responding, write after learning
2. **Entity detection** (Section 3): spawn on every message, capture people/companies/ideas
3. **Source attribution** (Section 7): every fact needs `[Source: ...]`
> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking.

Tell the user: "The production agent guide is at docs/VOLTMIND_SKILLPACK.md. It covers
the brain-agent loop, entity detection, enrichment, meeting ingestion, and cron
schedules. Read it when you're ready to go from 'search works' to 'the brain
maintains itself.'"

## Phase F: Health Check

Run `voltmind doctor --json` and report the results. Every check should be OK.
If any check fails, the doctor output tells you exactly what's wrong and how to fix it.

## Error Recovery

**If any voltmind command fails, run `voltmind doctor --json` first.** Report the full
output. It checks connection, pgvector, RLS, schema version, and embeddings.

| What You See | Why | Fix |
|---|---|---|
| OAuth discovery failed (`discovery_*`) | Wrong `--issuer-url`, Host unreachable, or `serve --http` not running on the Host | Confirm the issuer URL and that the Host is up; `curl` the `/.well-known/oauth-authorization-server` |
| `token_*` failed | Wrong `client_id`/`client_secret`, or the client lacks scopes | Re-request credentials from the Host; confirm `--scopes read write` was set |
| `mcp_smoke_*` failed | Wrong `--mcp-url` path, or the Host isn't serving `/mcp` | Confirm `<issuer>/mcp` matches the Host's served path |
| `missing_scope` on a tool call | Your OAuth client isn't granted that scope | Host re-registers the client with the needed scope (read / write / sources_admin) |
| `sync`/`embed`/`sources` errors | These run on the Host, not the thin client | Use `voltmind remote ping`, or run on the Host |
| No pages found | Querying before the source is populated | Ask the Host to import/sync the source, then re-search |

## Phase G: Auto-Update Check (if not already configured)

If the user's install did NOT include setting up auto-update checks (e.g., they
used the manual install path or an older version of the OpenClaw/Hermes paste), offer it:

> "Would you like daily VoltMind update checks? I'll let you know when there's a
> new version worth upgrading to — including new skills and schema recommendations.
> You'll always be asked before anything is installed."

If they agree:
1. Test: `voltmind check-update --json`
2. Register daily cron (see VOLTMIND_SKILLPACK.md Section 17)

If already configured or user declines, skip.

## Phase H: Live Sync Setup (MUST ADD)

The brain repo is the source of truth. If sync doesn't run automatically, the
vector DB falls behind and voltmind returns stale answers. This phase is not optional.

> **Thin client:** sync/embed run on the Host (they are refused locally on a thin
> client). Trigger a Host cycle with `voltmind remote ping`; the Host's autopilot
> handles the rest. This phase is for the Host operator only.

Read `docs/VOLTMIND_SKILLPACK.md` Section 18 for the full reference. Key points:

1. **Check the connection first.** VoltMind is tuned for the Supabase **Transaction
   pooler** (port 6543): it auto-disables prepared statements there and routes
   migrations, DDL, and sync transactions to a separate direct connection. That
   derived direct connection (`db.<ref>.supabase.co:5432`) is IPv6-only, so on an
   IPv4-only host, reads work but sync silently skips pages. Fix by making the
   direct connection reachable: set `VOLTMIND_DIRECT_DATABASE_URL` to the **Session
   pooler** string (port 5432 on the `pooler.supabase.com` host, IPv4), or enable
   Supabase's IPv4 add-on.

2. **Set up automatic sync.** Choose the approach that fits your environment:
   - **Cron** (recommended for agents): register a cron every 5-30 minutes:
     `voltmind sync --repo /data/brain && voltmind embed --stale`
   - **Watch mode**: `voltmind sync --watch --repo /data/brain` under a process
     manager. Pair with a cron fallback (watch exits after 5 consecutive failures).
   - **Webhook or git hook**: if available in your environment.

3. **Verify sync works.** Don't just check that the command ran. Check that it
   worked:
   - `voltmind stats` should show page count close to syncable file count in the repo.
   - If page count is way too low, the direct connection is unreachable on IPv4 and
     sync is silently skipping pages (see point 1).
   - Push a test change and confirm it appears in `voltmind search`.

4. **Chain sync + embed.** Always run both: `voltmind sync --repo <path> && voltmind
   embed --stale`. For small syncs, embeddings are generated inline. The `embed
   --stale` is a safety net for any stale chunks.

Tell the user: "Live sync is configured. The brain will stay current automatically.
I'll verify it's working in the next phase."

## Phase I: Full Verification

Run the full verification runbook to confirm the entire installation is working.

1. Read `docs/VOLTMIND_VERIFY.md`
2. Execute each check in order
3. Report results to the user
4. Fix any failures before declaring setup complete

Every check in the runbook should pass. The most important one is check 4 (live
sync actually works): push a change, wait for sync, search for the corrected text.
"Sync ran" is not the same as "sync worked."

Tell the user: "I've verified the full VoltMind installation. Here's the status of
each check: [list results]. Everything is working / [specific item] needs attention."

If already configured or user declines, skip.

## Phase J: Cold Start — Populate Your Brain (AUTOMATIC)

Setup is done. The brain works. But it's empty. **This is the most important
moment** — an empty brain is useless. Transition directly to the cold-start
skill to fill it with the user's actual data.

**Do not end setup without offering cold-start.** The user just invested 15+
minutes in setup. The payoff is seeing their brain come alive with their own
data. Stopping here is like installing a phone and never adding contacts.

Present this immediately after verification passes:

> "✅ VoltMind is set up and verified. Now let's fill it with your data.
>
> I can connect your Google services (contacts, calendar, email), import
> your existing notes, pull in conversations from ChatGPT/Claude, and
> archive your tweets — all in one session. Each step is optional.
>
> **Ready to populate your brain?**"

If the user says yes (or anything affirmative):
→ **Load and execute `skills/cold-start/SKILL.md`** immediately. Do not
just print a reference — actually run the cold-start skill.

If the user says no or wants to stop:
→ Create a deferred cold-start manifest under `brain/state/indexes/` from
`templates/cold-start-ingest-manifest.md`, with `status: deferred`,
`next_phase: 0`, and the deferral timestamp in its run summary.
→ Tell them: "You can run cold-start anytime by asking me to 'fill my brain'
or 'cold start'."

## Schema State Tracking

After presenting the recommended directories (Phase C/E) and the user selects which
ones to create, write `~/.voltmind/update-state.json` recording:
- `schema_version_applied`: current voltmind version
- `skillpack_version_applied`: current voltmind version
- `schema_choices.adopted`: directories the user created
- `schema_choices.declined`: directories the user explicitly skipped
- `schema_choices.custom`: directories the user added that aren't in the recommended schema

This file enables future upgrades to suggest new schema additions without
re-suggesting things the user already declined.

## Anti-Patterns

- **Ending setup without offering cold-start.** An empty brain is useless. Phase J (cold-start) is where setup pays off. Always present the "Ready to populate?" prompt after verification. Skipping this is like installing an app and never logging in.
- **Asking for a database connection string or Supabase key on a thin client.**
  You connect to the Host's MCP server with OAuth credentials; the database stays host-side.
- **Skipping live sync setup.** If sync doesn't run automatically, the vector DB falls behind and search returns stale answers. Phase H is not optional.
- **Declaring setup complete without verification.** "The command ran" is not the same as "it worked." Push a test change, wait for sync, search for the corrected text.
- **Leaving the direct connection unreachable on IPv4.** VoltMind uses the Transaction pooler (port 6543) for reads and a derived direct connection (`db.<ref>.supabase.co:5432`, IPv6-only) for migrations, DDL, and sync transactions. On an IPv4-only host, reads work but sync silently skips pages. Set `VOLTMIND_DIRECT_DATABASE_URL` to the Session pooler string (port 5432, IPv4), or enable the IPv4 add-on.
- **Importing without proving search.** The magical moment is the user seeing search find things grep couldn't. Don't skip it.

## Output Format

```
VOLTMIND SETUP COMPLETE
=====================

Endpoint: https://<host-public-url>/mcp
Source: [default / <source id>]
Connection: [OAuth verified / MCP initialize OK]
Pages imported: N
Embeddings: N/N (keyword search active, semantic improving)
Live sync: [configured / method]
Health check: all OK / [specific failures]
Verification: [VOLTMIND_VERIFY.md results]

🧠 Ready to populate your brain? I can connect your Google services,
import your notes, and pull in your conversations — all in one session.
→ Launching cold-start...
```

**The output should transition directly into cold-start (Phase J), not end
with a bullet list.** The bullet list is for when the user defers cold-start.

## Tools Used

- `voltmind init --mcp-only --issuer-url ... --mcp-url ... --oauth-client-id ... --oauth-client-secret ...` -- connect to the Host as a thin client
- `voltmind remote ping` -- trigger a Host sync/embed cycle
- `voltmind import <dir> --no-embed [--workers N]` -- import files (Host only)
- `voltmind search <query>` -- search brain
- `voltmind doctor --json` -- health check
- `voltmind check-update --json` -- check for updates
- `voltmind embed --stale` -- backfill missing embeddings
- `voltmind sync --repo <path>` -- one-shot sync from brain repo
- `voltmind sync --watch --repo <path>` -- continuous sync polling
- `voltmind config get sync.last_run` -- check last sync timestamp
- `voltmind stats` -- page count + embed coverage
