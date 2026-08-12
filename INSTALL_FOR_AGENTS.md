# VoltMind Installation Guide for AI Agents

Read this entire file, then follow the steps. Ask the user for API keys when needed.
Target: ~30 minutes to a fully working brain.

This guide's default topology is a **remote thin client**. Every target user must
provision a personal private Gogs source, receive a source-scoped OAuth client, and
connect to the company VoltMind Host. A plain `git clone` never grants brain access.

The local PGLite path is retained only as an explicit standalone exception for
offline development or runtime testing. Do not select it for normal user onboarding.

## Before Step 0: Prepare the computer

This checklist assumes a clean computer where nothing has been installed yet and
the operator is not familiar with command-line tools. Complete it before reading
or following Step 0. The agent should install missing prerequisites when it has a
shell and the user has approved machine-level software installation; if the host
requires an approval prompt, stop at that prompt instead of pretending the
dependency is available.

### Required for the standard remote thin-client install

You need all of the following:

1. **A supported desktop operating system and a terminal.** On Windows, use
   PowerShell (already included with Windows 10/11). On macOS, use Terminal. On
   Linux, use the distribution's terminal.
2. **An internet connection** that can reach `bun.sh`, GitHub, and any AI API
   provider selected later. A corporate proxy or firewall may need to allow these
   sites.
3. **Git**, because the standard install downloads VoltMind from GitHub and the
   fallback install uses `git clone`.
4. **Node.js LTS**, because the package installation hook and helper scripts invoke
   `node`. The VoltMind CLI itself runs on Bun, but Node.js is still needed for the
   normal installation path.
5. **Bun 1.3.10 or newer**, which is VoltMind's required runtime and package manager.
6. **A working PATH**, so a newly opened terminal can find `git`, `node`, and `bun`.

`npm` is normally installed together with Node.js, but VoltMind does not require
`npm`; use Bun for the commands in this guide.

### Check before continuing

Run these commands in a new terminal. Every required command must print a version
number. If a command says that it is not recognized or not found, install that
tool first, open a new terminal, and run the checks again.

PowerShell (Windows):

```powershell
git --version
node --version
bun --version
```

Terminal (macOS/Linux):

```bash
git --version
node --version
bun --version
```

Confirm that the Bun version is at least `1.3.10`. If the version is older, update
Bun before continuing. On Windows, install Git and Node.js LTS from their official
download pages, then install Bun with the official Windows installer at
<https://bun.sh/docs/installation>. On macOS/Linux, install Git and Node.js LTS
using the operating system's official package source, then install Bun from
<https://bun.sh/docs/installation>.

After installing anything, close and reopen the terminal so the updated PATH is
loaded. Do not continue to Step 0 until `git --version`, `node --version`, and
`bun --version` all work in that new terminal.

### Agent action: install missing prerequisites

The agent must not assume that ChatGPT Desktop provides a JavaScript runtime.
ChatGPT Desktop is the agent interface; Bun and Node.js are separate local
software. If a check fails, install only the missing prerequisite, then repeat the
checks in a new terminal.

On Windows, use the official installers or the Windows package manager when it is
available:

```powershell
# Git is already present when this repository was successfully cloned.
winget install --id OpenJS.NodeJS.LTS -e
powershell -c "irm https://bun.sh/install.ps1|iex"
```

If `winget` is unavailable or blocked, use the official Node.js LTS download at
<https://nodejs.org/en/download> and the official Bun instructions at
<https://bun.sh/docs/installation>. Do not install a similarly named third-party
package. Bun's Windows installer may place the executable at
`$env:USERPROFILE\.bun\bin\bun`; if `bun --version` is not found after the
installer, verify that path, add it to the user's `PATH`, and open a new terminal.

On macOS/Linux, use the operating system's official package source for Node.js LTS
and Git, then install Bun from <https://bun.sh/docs/installation>. The exact
package-manager command is intentionally left to the detected distribution.

### Not required for the default remote thin-client install

Do **not** block client onboarding on these optional components:

- Docker or a local PostgreSQL server
- A Supabase account or database
- Python
- An IDE or code editor
- `npm`

The default remote path keeps the database, embeddings, and background workers on
the Host, so the client does not need Docker, PostgreSQL, Supabase, Python, or
embedding/chat API keys. A local PGLite setup or platform integration may introduce
additional requirements; install those only for the explicit standalone exception.

### Source checkout bootstrap (the path for this cloned repository)

Run this from the root of the cloned VoltMind repository. This installs the local
CLI client that the agent uses to complete Gogs/source provisioning and connect to
the Host; cloning alone is not an installation:

```bash
bun install --frozen-lockfile       # install package dependencies
bun run build                       # compile bin/voltmind (bin/voltmind.exe on Windows)
bun run src/cli.ts --version        # source-runtime smoke test
bun link                            # optional: expose this checkout as `voltmind`
voltmind --version                  # run this only if `bun link` succeeded
```

The compiled binary is useful for a stable local runtime or an MCP process, but it
is not a prerequisite for editing Markdown skills. When `voltmind` is not on
`PATH`, use `bun run src/cli.ts <command>` for every command in this guide. Do not
run `bun run build` before `bun install`.

If the package install hook fails only because `node` is unavailable, install Node
LTS and rerun the normal command. As a controlled fallback, an agent may run
`bun install --frozen-lockfile --ignore-scripts`, then use the source runtime; if
the initialized brain reports a stale schema, run
`bun run src/cli.ts apply-migrations --yes`. Do not hide a real dependency or
network error by permanently using `--ignore-scripts`.

## Step 0: If you are not Claude Code

Read `AGENTS.md` at the repo root first. It's the non-Claude-agent operating
protocol (install, read order, trust boundary, common tasks). Claude Code reads
`CLAUDE.md` automatically and can skip ahead.

If you fetched this file by URL without cloning yet, the companion files live at:
- `https://raw.githubusercontent.com/Justike001/voltmind/master/AGENTS.md` — start here
- `https://raw.githubusercontent.com/Justike001/voltmind/master/llms.txt` — full doc map
- `https://raw.githubusercontent.com/Justike001/voltmind/master/llms-full.txt` — same map, inlined

## Step 1: Install VoltMind

Default path (Bun is required — voltmind is a Bun + TypeScript runtime):

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun install -g github:Justike001/voltmind
```

Verify: `voltmind --version` should print a version number. If `voltmind` is not found,
restart the shell or add the PATH export to the shell profile.

> **If `bun install -g` aborts or `voltmind doctor` reports `schema_version: 0`** (Bun
> occasionally blocks the top-level postinstall hook on global installs, so schema
> migrations don't run automatically), the CLI prints a recovery hint pointing at
> [#218](https://github.com/Justike001/voltmind/issues/218). Run `voltmind apply-migrations --yes`
> to recover. If that doesn't work, fall back to the deterministic install path:
>
> ```bash
> git clone https://github.com/Justike001/voltmind.git ~/voltmind && cd ~/voltmind
> bun install && bun link
> ```

## Step 2: Host credentials and optional API keys

For the default remote thin-client route, do **not** ask the user for embedding,
reranker, chat-model, database, or Supabase keys. The Host owns those credentials.
The user needs the Gogs token and the source-scoped OAuth credentials described in
Step 3 and `skills/setup/SKILL.md`.

The provider sections below apply to a company Host operator or to the explicit
local standalone exception only.

### Company-internal Qwen deployment

When the operator requires embeddings and reranking to stay inside the company
network, do not request public embedding or reranker API keys. Follow
[`docs/ai-providers/qwen-vllm.md`](docs/ai-providers/qwen-vllm.md) instead.
It configures the internal Qwen text/image embedding and reranking services,
creates a new `halfvec(2048)` Supabase brain, and verifies the routes before
any sensitive data is imported.

For non-company deployments, ask the user which public provider they want to
use. OpenAI, Voyage, and ZeroEntropy remain supported through
`voltmind config set embedding_model <provider:model>`.

```bash
export ZEROENTROPY_API_KEY=ze-...     # default embedding + reranker (v0.36.2.0+)
export OPENAI_API_KEY=sk-...          # fallback for vector search; also used for chat models
export ANTHROPIC_API_KEY=sk-ant-...   # optional, improves search quality via query expansion
```

Save to shell profile or `.env`. Keys are picked up by `voltmind config set` automatically
or can be stored in `~/.voltmind/config.json` (file plane). Without any embedding provider,
keyword search still works. Without Anthropic, search works but skips query expansion.

## Step 3: Remote Host onboarding (required for end users)

Read and follow `skills/setup/SKILL.md` now. The end-user path is:

1. Create a private personal knowledge repo in company Gogs and make an initial
   commit.
2. Create the user's Gogs token and submit the Host self-provision request (or ask
   the Host operator to run the admin provisioning path).
3. Use the returned source ID, OAuth client ID, and client secret:

```bash
voltmind init --mcp-only \
  --issuer-url https://<host-public-url> \
  --mcp-url https://<host-public-url>/mcp \
  --oauth-client-id <client_id> \
  --oauth-client-secret <client_secret>
voltmind doctor --json
voltmind search "<topic you know is in the brain>"
```

Do not run local `voltmind init --pglite` for normal user onboarding. Imports,
sync, embeddings, graph extraction, and Autopilot run on the Host. Continue with
the remote phases in `skills/setup/SKILL.md`.

## Local standalone exception: create a local brain

Use the explicit local PGLite path. A fresh agent shell is often non-interactive,
so do not make the first install depend on an embedding provider or an interactive
prompt:

```bash
# If an embedding provider key is already configured:
voltmind init --pglite

# If no embedding key is configured (recommended first boot):
voltmind init --pglite --no-embedding

voltmind doctor --json                  # verify the local engine
```

With a source checkout, replace `voltmind` with `bun run src/cli.ts` unless the
checkout was linked. `--no-embedding` still gives working keyword search; configure
an embedding provider later and run `voltmind embed --stale` to add semantic
search. Do not request a Supabase URL just to get the first local brain running.

The user's markdown files (notes, docs, brain repo) are SEPARATE from this tool repo.
Ask the user where their files are, or create a new brain repo:

```bash
mkdir -p ~/brain && cd ~/brain && git init
```

Read `~/voltmind/docs/VOLTMIND_RECOMMENDED_SCHEMA.md` and set up the MECE directory
structure (people/, companies/, concepts/, etc.) inside the user's brain repo,
NOT inside ~/voltmind.

## Step 3.5: Confirm search mode with the user (DO NOT SKIP)

`voltmind init` auto-applied a default search mode (`tokenmax` unless your subagent
tier is Haiku-class or no OpenAI key is configured). The init output included the
cost matrix below preceded by `[AGENT]` markers. You must NOT silently accept the
default. Stop and ask the operator.

**Present this matrix verbatim:**

```
Per-query cost @ 10K queries/mo (typical single-user volume):

                  Haiku 4.5     Sonnet 4.6    Opus 4.7
                  ($1/M)        ($3/M)        ($5/M)
  conservative    $40/mo        $120/mo       $200/mo
  balanced        $100/mo       $300/mo       $500/mo
  tokenmax        $200/mo       $600/mo       $1,000/mo

(scales linearly: ×10 for 100K/mo, ÷10 for 1K. 25x corner-to-corner spread.
 Natural diagonal pairings — cheap/cheap → frontier/frontier — span ~4x.)
```

**Ask the operator (paraphrase if needed):**

> Your voltmind just installed with search mode `<auto-applied default>`. This is
> a one-time setup decision that controls retrieval payload size. Which mode
> do you want?
>
>   1) conservative — tight 4K budget, no LLM expansion, 10 chunks max.
>      Best for Haiku subagents, cost-sensitive setups, high-volume loops.
>
>   2) balanced — 12K budget, no expansion, 25 chunks. Sonnet-tier sweet spot.
>
>   3) tokenmax (recommended default — preserves v0.31.x retrieval shape) —
>      no budget, LLM expansion ON, 50 chunks. Best for Opus/frontier models.
>
> Cost depends on BOTH the mode AND the downstream model you run. See the
> matrix above for the 9-cell breakdown.

If the operator picks a non-default mode, run:
```bash
voltmind config set search.mode <mode>
```

If they pick tokenmax AND want to preserve the literal v0.31.x default
(limit=20 instead of tokenmax's 50), also run:
```bash
voltmind config set search.searchLimit 20
```

Verify the choice with `voltmind search modes` before continuing.

**Why this matters:** the cost spread between corners of the matrix is 25x.
An agent that silently accepts the default and starts running queries against
a user who didn't expect tokenmax-class context loads can rack up surprise
spend. Confirm before continuing.

## Step 4: Import and Index

```bash
voltmind import ~/brain/ --no-embed     # import markdown files
voltmind embed --stale                  # generate vector embeddings
voltmind query "key themes across these documents?"
```

## Step 4.5: Wire the Knowledge Graph

If the user already had a brain repo (Step 3 imported existing markdown), backfill
the typed-link graph and structured timeline. This populates the `links` and
`timeline_entries` tables that future writes will maintain automatically.

```bash
voltmind extract links --source db --dry-run | head -20    # preview
voltmind extract links --source db                         # commit
voltmind extract timeline --source db                      # dated events
voltmind stats                                             # verify links > 0
```

For brand-new empty brains, skip this step — auto-link populates the graph as the
agent writes pages going forward. There is nothing to backfill yet.

After this step:
- `voltmind graph-query <slug> --depth 2` works (relationship traversal)
- Search ranks well-connected entities higher (backlink boost)
- Every future `put_page` auto-creates typed links and reconciles stale ones

If a user has a very large brain (>10K pages), `extract --source db` is idempotent
and supports `--since YYYY-MM-DD` for incremental runs.

## Step 5: Load Skills

If you're running an agent platform (OpenClaw, Hermes, or any repo with a workspace),
scaffold the bundled skills into it:

```bash
cd /path/to/agent/workspace
voltmind skillpack scaffold --all       # copy 43 curated skills + RESOLVER.md
```

Scaffolded skills are first-class files in your repo. Edit freely; re-running scaffold
refuses to overwrite anything that exists. Use `voltmind skillpack reference <name>` to
diff against voltmind's bundle when you want upstream improvements. (The legacy
`voltmind skillpack install` managed-block model was retired in v0.36.0.0 — run
`voltmind skillpack migrate-fence` once if upgrading from an older release.)

Whether you scaffolded or not, read `skills/RESOLVER.md` (in your workspace, or the
bundled copy at `~/voltmind/skills/RESOLVER.md` when running from the cloned repo). It's
the skill dispatcher — tells you which skill to read for any task. Save this to your
memory permanently.

If the cloned VoltMind repository is already the agent workspace, do **not** copy
the skills back into the same repository. Read and edit `skills/` in place. After a
skill edit, validate the resolver and runtime from the checkout:

```bash
bun run src/cli.ts check-resolvable --strict --mvp-only --skills-dir skills/
bun run typecheck
bun run build
```

`bun run build` is required after runtime/source changes; Markdown-only skill edits
primarily need the resolver check. The full `bun run verify` suite also uses shell
scripts and is not the first-install prerequisite on Windows.

The three most important skills to adopt immediately:

1. **Signal detector** (`skills/signal-detector/SKILL.md`) — fire this on EVERY
   inbound message. It captures ideas and entities in parallel. The brain compounds.

2. **Brain-ops** (`skills/brain-ops/SKILL.md`) — brain-first lookup on every response.
   Check the brain before any external API call.

3. **Conventions** (`skills/conventions/quality.md`) — citation format, back-linking
   iron law, source attribution. These are non-negotiable quality rules.

## Step 6: Identity (optional)

Run the soul-audit skill to customize the agent's identity:

```
Read skills/soul-audit/SKILL.md and follow it.
```

This generates SOUL.md (agent identity), USER.md (user profile), ACCESS_POLICY.md
(who sees what), and HEARTBEAT.md (operational cadence) from the user's answers.

If skipped, minimal defaults are installed automatically.

## Step 7: Recurring Jobs

Set up using your platform's scheduler (OpenClaw cron, Railway cron, crontab), or skip the
platform glue entirely with `voltmind autopilot --install` (built-in self-maintaining daemon):

For the first local PGLite install, do not install Autopilot just to make the brain
usable. Windows Autopilot/Minions requires a Postgres/Supabase topology; local
PGLite is single-writer and should use explicit `sync`/`embed` commands or the
agent's normal task loop. Configure Autopilot only after migrating to a supported
Postgres/Supabase setup and reading its platform-specific guide.

`voltmind autopilot --install` is platform-aware. On Ubuntu/Linux it selects
`linux-systemd`, `ephemeral-container`, or `linux-cron`; it never installs the
Windows Task Scheduler adapter. Do not pass `--target windows-task` or set
`VOLTMIND_AUTOPILOT_TARGET=windows-task` on a Linux host. The runtime rejects
that cross-platform target.

- **Live sync** (every 15 min): `voltmind sync --repo ~/brain && voltmind embed --stale`
  — or `voltmind sync --watch` for a continuous loop.
- **Auto-update** (daily): `voltmind check-update --json` (tell user, never auto-install).
- **Dream cycle** (nightly): `voltmind dream` runs the 8-phase overnight maintenance cycle.
  Entity sweep, citation fixes, memory consolidation, plus (v0.23+) overnight conversation
  synthesis and cross-session pattern detection. One cron-friendly command. This is what
  makes the brain compound. Do not skip it. See `docs/guides/cron-schedule.md` for the
  full protocol.
- **Weekly**: `voltmind doctor --json && voltmind embed --stale`

## Step 8: Integrations

Run `voltmind integrations list`. Each recipe in `~/voltmind/recipes/` is a self-contained
installer. It tells you what credentials to ask for, how to validate, and what cron
to register. Ask the user which integrations they want (email, calendar, voice, Twitter).

Verify: `voltmind integrations doctor` (after at least one is configured)

## Step 9: Verify

Read `docs/VOLTMIND_VERIFY.md` and run all 7 verification checks. Check #4 (live sync
actually works) is the most important.

## Windows release acceptance

When validating a published VoltMind Windows release, do not substitute unit
tests for a real scheduler check. On a clean Windows account or VM, use the
published `voltmind-windows-x64.exe`, its release SHA-256, and a disposable
Postgres database. The host-local harness creates a temporary `VOLTMIND_HOME`,
downloads and hashes the binary, registers the actual Task Scheduler task,
starts it, and checks Scheduler registration, Autopilot PID, heartbeat, and
database readiness before cleaning up:

```powershell
./scripts/windows-release-acceptance.ps1 `
  -ReleaseUrl 'https://github.com/Justike001/voltmind/releases/download/vX.Y.Z/voltmind-windows-x64.exe' `
  -ExpectedSha256 '<sha256-from-release>' `
  -DatabaseUrl 'postgresql://<disposable-user>:<password>@<host>:5432/<db>'
```

Keep the final status JSON, task XML/screenshot,
Last Run Result, and log excerpt as release evidence, with credentials and
private paths redacted. See `docs/operations/windows-release-acceptance.md`.

## Upgrade

If you installed via `bun install -g`:

```bash
voltmind upgrade                        # self-updates the binary, runs schema migrations,
                                      # and prints post-upgrade notes for the version range
```

If you installed via `git clone + bun link`:

```bash
cd ~/voltmind && git pull origin master && bun install
voltmind apply-migrations --yes         # apply schema migrations (idempotent)
voltmind post-upgrade                   # show migration notes for the version range
```

Then read `~/voltmind/skills/migrations/v<NEW_VERSION>.md` (and any intermediate
versions you skipped) and run any backfill or verification steps it lists. Skipping
this is how features ship in the binary but stay dormant in the user's brain.

**v0.32.3 search modes (one-time upgrade prompt):** if the user's brain was
created before v0.32.3, `voltmind post-upgrade` prints a banner including the
9-cell cost matrix (mode × downstream model) preceded by `[AGENT]` markers.
**Do NOT silently move past the banner.** Present the matrix to the operator
verbatim, ask which mode they want (recommended default: `tokenmax` to preserve
v0.31.x retrieval shape), then run `voltmind config set search.mode <mode>`. See
Step 3.5 above for the full ask-the-user protocol — the upgrade path uses the
same matrix and same default.

For v0.12.0+ specifically: if your brain was created before v0.12.0, run
`voltmind extract links --source db && voltmind extract timeline --source db` to
backfill the new graph layer (see Step 4.5 above).

For v0.12.2+ specifically: if your brain is Postgres- or Supabase-backed and
predates v0.12.2, the `v0_12_2` migration runs `voltmind repair-jsonb`
automatically during `voltmind post-upgrade` to fix the double-encoded JSONB
columns. PGLite brains no-op. If wiki-style imports were truncated by the old
`splitBody` bug, run `voltmind sync --full` after upgrading to rebuild
`compiled_truth` from source markdown.

## v0.42.0+ onboard surface (NEW)

`voltmind onboard` is the activation surface voltmind did not have before.
Once your brain has any content, run `voltmind onboard --check --json` to
see structured recommendations across 5 brain-health axes (orphans,
stale embeddings, entity link coverage, timeline coverage, takes count).

**On first connect (after `voltmind init`):**
```bash
voltmind onboard --check --json
```
The JSON envelope (`schema_version: 1`) carries `recommendations[]` with
`apply_policy` per item: `auto_apply` (safe to run unattended),
`prompt_required` (needs explicit user consent), or `manual_only`
(LLM-bearing, user must run themselves).

**After every `voltmind upgrade`:**
```bash
voltmind onboard --check --json
```
New versions may surface new opportunities. The post-upgrade banner
nudges the user when it runs, but agents should re-probe as a hygiene
step regardless.

**Unattended remediation (cron / autopilot):**
```bash
voltmind onboard --auto --max-usd 5
```
Refuses without `--max-usd N`. Runs auto-eligible items only. The
autopilot daemon also consults onboard recommendations on its tick — no
explicit agent action needed for the autonomous path.

**Remote / federated brain installs (MCP):**
The `run_onboard` MCP op (admin scope) lets thin-client agents probe
brain health + drive remediation over OAuth-authenticated MCP. Protected
LLM-bearing handlers (synthesize, patterns, consolidate, takes-bootstrap,
contextual_reindex_per_chunk) require the additional `run_protected_onboard`
scope — admin alone is insufficient. The MCP op returns
`skipped_missing_scope[]` listing what would have run with the right
grants.

**Privacy + consent gates:**
- `voltmind takes extract --from-pages` sends concept/atom/lore/briefing/
  writing/originals page content to your configured chat model (default
  Anthropic Haiku). Refuses to run unless `takes.bootstrap_enabled=true`
  is set in config AND `--yes` is passed. Two-gate opt-in by design.
- Autopilot's auto-apply tier for takes-bootstrap stays `manual_only`
  until v0.42.1's eval gate (do not bypass).

**Suppress nudges in CI / scripted environments:**
```bash
export VOLTMIND_NO_ONBOARD_NUDGE=1
```
Init + upgrade banners auto-skip in non-TTY too.
