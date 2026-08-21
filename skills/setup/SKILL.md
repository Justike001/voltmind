---
name: setup
description: "User-agent setup manual: provision a personal Gogs source, obtain source-scoped read/write OAuth credentials, connect as a thin client to the company VoltMind Host, and persist the connection; local checkout/runtime setup is an explicit standalone exception."
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

# Setup VoltMind — User Agent Manual

## Route setup before asking for credentials

This skill's target topology is a **remote company VoltMind Host**. All target
users must go through the Gogs + source provisioning + OAuth flow before the agent
tries to use the brain. A plain `git clone`, ChatGPT Desktop, or a local checkout
does not replace that flow and is not a reason to skip it.

- **Remote route (default and required):** follow the Host connection manual below.
  If the user has no credentials yet, guide them through the private Gogs repo,
  self-provision request, source ID, and OAuth client steps first.
- **Local standalone exception:** only use **Local checkout bootstrap** when the
  user explicitly asks for an isolated local engine, offline development, or a
  local runtime test. This is not the normal user onboarding path.

### Local standalone exception: checkout bootstrap

This is the path for “ChatGPT Desktop + `git clone` and nothing else”. A clone is
source code, not an installed CLI. Read [`INSTALL_FOR_AGENTS.md`](../../INSTALL_FOR_AGENTS.md)
completely and follow its prerequisite section before running any `voltmind`
command.

1. Detect the OS and check `git --version`, `node --version`, and `bun --version`.
   Git is normally already present because the repository was cloned. Install
   Node.js LTS and Bun `>=1.3.10` when missing. ChatGPT Desktop is not a substitute
   for either runtime. Restart the terminal after installers update `PATH`.
2. From the repository root, install the locked dependencies and compile the local
   executable:

   ```bash
   bun install --frozen-lockfile
   bun run build
   bun run src/cli.ts --version
   bun link                         # optional convenience command
   ```

   The source runtime (`bun run src/cli.ts <command>`) is always the fallback. The
   compiled `bin/voltmind`/`bin/voltmind.exe` is a packaging/runtime artifact, not
   a replacement for installing the package dependencies first.
3. Create a local brain. If no embedding provider key is available, use the
   non-interactive-safe path:

   ```bash
   bun run src/cli.ts init --pglite --no-embedding
   bun run src/cli.ts doctor --json
   ```

   If an embedding key is already configured, `init --pglite` may be used instead.
   Keyword search works without embeddings; configure a provider later and run
   `embed --stale` when semantic search is wanted.
4. Keep the user's brain repo separate from this VoltMind source checkout. Ask for
   a notes/brain path before importing files; never import the repository's own
   `node_modules`, `dist`, `.git`, or build output into the brain by accident.
5. Because this checkout already contains `skills/`, read `skills/RESOLVER.md` and
   edit skills in place. Do not scaffold the same skillpack over itself. Validate
   edits with:

   ```bash
   bun run src/cli.ts check-resolvable --strict --mvp-only --skills-dir skills/
   bun run typecheck
   bun run build
   ```

6. Continue with the local import, brain-first, and verification guidance below.
   Skip the company Host phases that start at **Phase A: Create your personal
   knowledge repo in company Gogs**. If a command is written as `voltmind ...` but
   `bun link` was not used, run it as `bun run src/cli.ts ...` instead.

## Remote route: Host connection manual

This is the operating instruction manual for a **user's agent** connecting to the
company VoltMind Host. Follow it in order to: create your own personal knowledge
repo in the company Gogs, get your own **sourceID** + **read/write** permission on
the Host, connect as a thin client to the Host's MCP server, and persist those
credentials so your agent can use them on every run.

## Company deployment endpoints

This setup manual targets the company's fixed VoltMind deployment. Use these
endpoints exactly; do not replace them with generic placeholders:

| What | Value |
|---|---|
| MCP / OAuth issuer | `https://voltage3d.tailce7d39.ts.net` |
| MCP endpoint | `https://voltage3d.tailce7d39.ts.net/mcp` |
| Self-provision (`/provision/request`) | `https://voltage3d.tailce7d39.ts.net/provision/request` |
| Company Gogs | `http://192.168.5.6:3000` |
| Gogs organization | `http://192.168.5.6:3000/VoltMind` |
| Gogs API | `http://192.168.5.6:3000/api/v1` |
| Gogs SSH clone form | `voltage@192.168.5.6:VoltMind/<repo>.git` |

**Security boundary you rely on:** you (the user's agent) only ever get
**read/write on your OWN `personal-*` source** — never admin, never anyone else's
data. The Host keeps the Gogs-admin key and all admin credentials to itself.

## Contract

- One company email ⇒ exactly ONE personal source (`personal-<name>`); applying
  again just re-keys the same source (no duplicate).
- Your thin client can search/read/write **only your own** source (scope isolation).
- You never receive a database connection string, the Gogs-admin SSH key, or any
  admin credential.

### Phase A — obtain a Gogs account and create your personal knowledge repo

Only execute this section after the remote-route check above succeeds.

1. Open the company Gogs at `http://192.168.5.6:3000`.
2. If you do not have a Gogs account, use the visible **Register** flow with
   your company email. If registration is disabled, ask the company Gogs
   administrator to create your account and add it to the `VoltMind`
   organization; do not continue until the account can sign in and the
   organization is visible.
3. If you have an account but are not a member of `VoltMind`, request an
   invitation or membership from the organization administrator. The agent must
   not create the personal brain repository outside that organization.
4. Read the login/username from the signed-in Gogs profile as `GOGS_USERNAME`.
   Generate the private repository name at runtime as:
   `GOGS_USERNAME + "_PersonalBrain"`. Thus the runtime username is preserved
   in the repository name (for example, `<GOGS_USERNAME>_PersonalBrain`); never
   hard-code a person's name in this skill.
5. Under the `VoltMind` organization, create that repository as **private** and
   push an initial commit (for example, `README.md`). The resulting web URL is
   `http://192.168.5.6:3000/VoltMind/<GOGS_USERNAME>_PersonalBrain`.
6. Get the repository's **SSH clone address** from Gogs → repository → Clone →
   SSH. It must have the form
   `voltage@192.168.5.6:VoltMind/<GOGS_USERNAME>_PersonalBrain.git`.
7. Create a Gogs personal access token from Gogs → Settings → Applications →
   Generate New Token. Grant only the minimum repository-read permission needed
   for the Host ownership check; this PAT is separate from the MCP OAuth
   client credentials.

## Phase A.5: Apply to the Host for your sourceID + read/write (self-provision)

One request to the Host creates your **source**, **checks out your repo**, and
**mints your read/write thin-client credential** — source + client + permission in
one step. Use the Gogs API token you just made:

```bash
curl -X POST "https://voltage3d.tailce7d39.ts.net/provision/request" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "<your company email>",
    "repo_url": "voltage@192.168.5.6:VoltMind/<GOGS_USERNAME>_PersonalBrain.git",
    "gogs_token": "<your Gogs personal access token>"
  }'
```

The Host verifies via the Gogs API (`/api/v1/user`) that the token's owner is you
and that you can read the repo — so you get **only your own** source. Response:

```json
{ "source_id": "personal-<name>", "already_provisioned": false,
  "clone_path": "...", "owner_email": "...",
  "client_id": "...", "client_secret": "..." }
```

Record `source_id` and `client_id` from this response as non-secret local
configuration. Store the returned `client_secret` immediately in the operating
system's secret manager under `VOLTMIND_REMOTE_CLIENT_SECRET`; never put it in
the repository, `AGENTS.md`, a prompt, shell history, or a committed `.env`
file. The Host currently grants the MCP client `read write` on this source;
there is no user-supplied OAuth `scope` field and the agent must not invent one.

> If `/provision/request` returns `404` (the operator keeps self-provision OFF by
> default), ask the Host's agent / admin to run the admin path or switch it on.

## Phase A.6: Clone and bind the local vault first

Client-first writes require a local `client_vault_path`. Complete this phase
before initializing the thin client:

```bash
git clone "<vault-or-personal-repo-ssh-url>" ~/vault
cd ~/vault
git remote -v
```

The checkout must be the personal source granted by the Host. Never use a
shared or another teammate's vault.

Resolve the checkout to an absolute path before continuing. This path is the
client vault path: it is the local write-ahead truth surface where
`voltmind put` and thin-client ingest write and validate `<slug>.md` before any
remote `put_page` call. It is not the Host database path and it is not the
agent skill repository.

The `--vault-path` argument also initializes the local Markdown vault before
the thin-client configuration is saved. This is additive and never overwrites
existing user files. It installs the canonical `voltmind-personal-brain`
scaffold, including the root `RESOLVER.md`, `schema.md`, `index.md`, and
`log.md`; the primary homes; `state/`; `contribution/`; the nested
`sources/teams/`, `sources/meetings/`, `sources/emails/`, and
`sources/calendar/` directories; each schema directory's `README.md`; and the
agent-facing templates and policy files. The runtime validates and activates
`voltmind-personal-brain` in the local client configuration. This creates no
local database: the thin client still uses the Host's MCP database.

## Phase A.7: Connect as a thin client

```bash
voltmind init --mcp-only \
  --vault-path ~/vault \
  --issuer-url "https://voltage3d.tailce7d39.ts.net" \
  --mcp-url "https://voltage3d.tailce7d39.ts.net/mcp" \
  --oauth-client-id "<client_id>"
voltmind doctor --json       # expect "status": "ok"
voltmind search "<a topic>"  # first retrieval
```

`voltmind init --mcp-only` is the MCP smoke test: it performs OAuth discovery,
the token round-trip, and an MCP `initialize` handshake before saving the
remote configuration. Treat a successful `init` as proof that the issuer,
client credentials, and MCP endpoint work together. Do not add a user-supplied
`--scopes` flag; the Host grants the source-scoped `read write` permission.

Before running this command, have the OS secret manager inject
`VOLTMIND_REMOTE_CLIENT_SECRET` into the process environment. The variable is
intentionally omitted from the command so the secret cannot land in shell
history or an instruction file.

After this command succeeds, confirm that the reported `client_vault_path` is
the same absolute directory that was scaffolded. `init --mcp-only` binds this
path in four stages: it reads `--vault-path` (or
`VOLTMIND_CLIENT_VAULT_PATH`), validates that the directory exists, installs
the additive local scaffold after the MCP smoke succeeds, and persists the
resolved path as `client_vault_path` in `~/.voltmind/config.json`. It does not
persist an operating-system environment variable itself.

## Phase A.8: Persist non-secret configuration safely

The source id, issuer URL, MCP URL, and client id are non-secret routing
configuration and may be recorded in your agent's local configuration or
`AGENTS.md`. The client secret is different: keep it only in an OS secret
manager or an untracked, permission-protected environment file. Never put it in
`AGENTS.md`, a brain page, a prompt, shell history, or a committed repository.

```bash
export VOLTMIND_SOURCE="<source_id from provision response>"
export VOLTMIND_REMOTE_ISSUER_URL="https://voltage3d.tailce7d39.ts.net"
export VOLTMIND_REMOTE_MCP_URL="https://voltage3d.tailce7d39.ts.net/mcp"
export VOLTMIND_REMOTE_CLIENT_ID="<client_id>"
export VOLTMIND_CLIENT_VAULT_PATH="<absolute-client-vault-path>"
```

Persist `VOLTMIND_CLIENT_VAULT_PATH` in the client workstation's environment
using its normal environment manager as well as the current shell. On
PowerShell, the current-session form is:

```powershell
$clientVaultPath = (Resolve-Path '<client-vault-dir>').Path
$env:VOLTMIND_CLIENT_VAULT_PATH = $clientVaultPath
[Environment]::SetEnvironmentVariable('VOLTMIND_CLIENT_VAULT_PATH', $clientVaultPath, 'User')
```

Use the OS/user environment settings or an untracked, permission-protected
environment file for persistence across new terminals. The variable is a
runtime override for `client_vault_path`; when both are present, the environment
value wins. Keep them identical to avoid writing one path locally while setup
documentation points at another.

Add the following non-secret, local operating note to the agent's `AGENTS.md`
(or its equivalent local-only agent instructions), replacing the placeholder
with the resolved absolute path:

```markdown
## VoltMind client vault

- `VOLTMIND_CLIENT_VAULT_PATH`: `<absolute-client-vault-path>`
- Purpose: local write-ahead vault for client-first ingest. `voltmind put`
  writes and validates `<vault>/<slug>.md` here before synchronizing the exact
  Markdown through remote `put_page`.
- The Host database, OAuth secret, and remote MCP credentials do not belong in
  this vault-path note.
```

Write the actual path only to the user's local AGENTS instructions. If the
project's tracked `AGENTS.md` is public or shared, use its ignored/local
equivalent rather than committing a workstation-specific path. Never put the
OAuth client secret in this block.

If an environment file is used, keep it outside version control with restrictive
permissions and load it through the platform's secret mechanism as
`VOLTMIND_REMOTE_CLIENT_SECRET` before running `voltmind init`; the runtime gives
the environment value precedence and does not persist it to the client config.
Do not paste it into an instruction file or shell command line.

From then on, `voltmind put`/`capture` writes the local vault first and records
the remote receipt. Host synchronization may follow; a direct remote
`put_page` is not a substitute for the client-first write.

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

> **Thin client:** `sync` is refused locally. Use `voltmind put` or `voltmind
> capture` so the local vault and pending receipt are written first; then let
> the Host process the receipt through its normal ingestion/autopilot path.

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
| `token_*` failed | Wrong `client_id`/`client_secret`, or the client lacks scopes | Re-request credentials from the Host; do not add a client-side scope flag |
| `mcp_smoke_*` failed | Wrong `--mcp-url` path, or the Host isn't serving `/mcp` | Confirm `<issuer>/mcp` matches the Host's served path |
| `missing_scope` on a tool call | The source-scoped client was not minted with the expected permission | Ask the Host to re-issue the client; the normal self-provision grant is fixed at `read write`, never `sources_admin` |
| `sync`/`embed`/`sources` errors | These run on the Host, not the thin client | Ask the Host operator to inspect or trigger the Host-side job; do not request admin scope for a personal client |
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

## Phase I: Client Verification

For a personal thin client, verify the client connection and local write path.
Host-side sync, indexing, embedding, and `voltmind remote ping` are outside this
setup skill because the personal client intentionally has only source-scoped
`read write`, not `admin` scope.

1. Run `voltmind doctor --json` and confirm OAuth/MCP connectivity.
2. Confirm the personal vault commit was pushed to the user's private Gogs repo.
3. Run a remote search. A zero-result search is inconclusive until the Host has
   pulled and indexed the source; ask the Host operator to verify sync before
   diagnosing the source or vault.
4. Read `docs/VOLTMIND_VERIFY.md` only when operating the Host-side verification
   workflow; do not block personal client setup on its Host sync checks.

Report Host indexing as `Host-managed / pending confirmation` when it has not yet
been verified. Do not ask the personal user to re-register with admin scope.

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
- **Treating Host sync as a personal-client setup failure.** Host sync and indexing are operator-managed; a personal client must not request admin scope just to trigger them.
- **Declaring client setup complete without verification.** "The command ran" is not the same as "it worked." Run `doctor --json`, verify the personal commit was pushed, and report Host indexing as pending when it has not been confirmed.
- **Leaving the direct connection unreachable on IPv4.** VoltMind uses the Transaction pooler (port 6543) for reads and a derived direct connection (`db.<ref>.supabase.co:5432`, IPv6-only) for migrations, DDL, and sync transactions. On an IPv4-only host, reads work but sync silently skips pages. Set `VOLTMIND_DIRECT_DATABASE_URL` to the Session pooler string (port 5432, IPv4), or enable the IPv4 add-on.
- **Declaring a remote search failure before Host indexing is confirmed.** A zero-result query can mean the Host has not pulled or indexed the source yet; ask the Host operator to verify sync first.

## Output Format

```
VOLTMIND SETUP COMPLETE
=====================

Endpoint: https://voltage3d.tailce7d39.ts.net/mcp
Source: [default / <source id>]
Connection: [OAuth verified / MCP initialize OK]
Pages imported: N
Embeddings: N/N (keyword search active, semantic improving)
Live sync: Host-managed / [confirmed / pending]
Health check: all OK / [specific failures]
Verification: [VOLTMIND_VERIFY.md results]

🧠 Ready to populate your brain? I can connect your Google services,
import your notes, and pull in your conversations — all in one session.
→ Launching cold-start...
```

**The output should transition directly into cold-start (Phase J), not end
with a bullet list.** The bullet list is for when the user defers cold-start.

## Tools Used

- `voltmind init --mcp-only --vault-path ... --issuer-url ... --mcp-url ... --oauth-client-id ...` -- connect to the Host as a thin client; read `VOLTMIND_REMOTE_CLIENT_SECRET` from the OS secret manager
- `voltmind import <dir> --no-embed [--workers N]` -- import files (Host only)
- `voltmind search <query>` -- search brain
- `voltmind doctor --json` -- health check
- `voltmind check-update --json` -- check for updates
- `voltmind embed --stale` -- backfill missing embeddings
- `voltmind sync --repo <path>` -- one-shot sync from brain repo
- `voltmind sync --watch --repo <path>` -- continuous sync polling
- `voltmind config get sync.last_run` -- check last sync timestamp
- `voltmind stats` -- page count + embed coverage
