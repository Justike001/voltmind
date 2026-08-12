---
name: setup
description: User-agent setup manual: provision a personal Gogs source, obtain source-scoped read/write OAuth credentials, connect as a thin client to the company VoltMind Host, and persist the connection; local checkout/runtime setup is an explicit standalone exception.
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

## Real endpoints (this Host)

| What | Value |
|---|---|
| MCP / OAuth issuer | `https://voltage3d.tailce7d39.ts.net` |
| MCP endpoint | `https://voltage3d.tailce7d39.ts.net/mcp` |
| Self-provision (`/provision/request`) | `https://voltage3d.tailce7d39.ts.net/provision/request` |
| Company Gogs (web) | `http://192.168.5.6:3000` |
| Gogs org | `http://192.168.5.6:3000/VoltMind` |
| Gogs API | `http://192.168.5.6:3000/api/v1` |
| Gogs SSH (clone form) | `voltage@192.168.5.6:VoltMind/<repo>.git` |

**Security boundary you rely on:** you (the user's agent) only ever get
**read/write on your OWN `personal-*` source** — never admin, never anyone else's
data. The Host keeps the Gogs-admin key and all admin credentials to itself.

## Contract

- One company email ⇒ exactly ONE personal source (`personal-<name>`); applying
  again just re-keys the same source (no duplicate).
- Your thin client can search/read/write **only your own** source (scope isolation).
- You never receive a database connection string, the Gogs-admin SSH key, or any
  admin credential.

### Phase A — create your personal knowledge repo in the company Gogs

Only execute this section after the remote-route check above succeeds.

1. You already have a company Gogs account. In Gogs (`http://192.168.5.6:3000`),
   under the org `VoltMind`, create a **private** personal knowledge repo, e.g.
   `VoltMind/<name>_PersonalBrain`, and push an initial commit (e.g. `README.md`).
2. Get the repo's **SSH clone address** (Gogs → your repo → Clone → SSH) — the form
   is `voltage@192.168.5.6:VoltMind/<repo>.git`.
3. Create a **Gogs personal access token** for your account: Gogs → Settings →
   Applications → Generate New Token (read scope is enough).

## Phase A.5: Apply to the Host for your sourceID + read/write (self-provision)

One request to the Host creates your **source**, **checks out your repo**, and
**mints your read/write thin-client credential** — source + client + permission in
one step. Use the Gogs API token you just made:

```bash
curl -X POST https://voltage3d.tailce7d39.ts.net/provision/request \
  -H "Content-Type: application/json" \
  -d '{
    "email": "<your company email>",
    "repo_url": "voltage@192.168.5.6:VoltMind/<repo>.git",
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

> If `/provision/request` returns `404` (the operator keeps self-provision OFF by
> default), ask the Host's agent / admin to run the admin path or switch it on.

## Phase A.6: Connect as a thin client

```bash
voltmind init --mcp-only \
  --issuer-url https://voltage3d.tailce7d39.ts.net \
  --mcp-url https://voltage3d.tailce7d39.ts.net/mcp \
  --oauth-client-id <client_id> \
  --oauth-client-secret <client_secret>
voltmind doctor --json       # expect "status": "ok"
voltmind search "<a topic>"  # first retrieval
```

## Phase A.7: Persist your credentials (so the agent reads them on every run)

Write into your **own repo's `AGENTS.md`** and/or your environment so your agent
always has them at run time:

```bash
export VOLTMIND_SOURCE=personal-<name>
export VOLTMIND_REMOTE_ISSUER_URL=https://voltage3d.tailce7d39.ts.net
export VOLTMIND_REMOTE_MCP_URL=https://voltage3d.tailce7d39.ts.net/mcp
export VOLTMIND_REMOTE_CLIENT_ID=<client_id>
export VOLTMIND_REMOTE_CLIENT_SECRET=<client_secret>
```

Mirror these into your repo's `AGENTS.md` under a `## voltmind credentials`
section so your agent picks them up automatically. Treat `client_secret` as
sensitive (`.env` / secret manager, never a public repo).

## Phase A.8: Clone your vault and bind your remote repo

After your source is provisioned, set up your local working copy and bind it to
your personal remote repo so your local writes stay in sync with what the Host
checks out:

```bash
# clone the vault template or your own personal repo:
git clone voltage@192.168.5.6:VoltMind/brain.git ~/vault
# (or) git clone voltage@192.168.5.6:VoltMind/<repo>.git ~/vault

# bind the remote so your local vault tracks your personal KB repo:
cd ~/vault
git remote add origin voltage@192.168.5.6:VoltMind/<repo>.git   # if not already set
git remote -v
```

From then on: write to your vault → `git push` → the Host syncs it into your
source → `voltmind search` returns it.

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
