# Install

Three install paths. Pick one. Mix later if needed.

## 1. Run with an agent platform (recommended)

Already running [OpenClaw](https://github.com/openclawagents/openclaw) or [Hermes](https://github.com/openclawagents/hermes)?

```bash
bun install -g github:Justike001/voltmind
voltmind init --pglite                  # 2 seconds; no server
voltmind skillpack scaffold --all       # 43 skills scaffolded into your agent workspace
voltmind doctor                         # green checks all the way down
```

Your agent now reads `skills/RESOLVER.md` once per request, routes intent to the right skill, executes. New entity mentions create new pages. For Postgres/Supabase deployments, the host-local Autopilot scheduler can run enrichment overnight; PGLite uses manual or inline maintenance.

Scaffolded skills are first-class files in your agent repo — edit freely. To pull upstream VoltMind improvements later, `voltmind skillpack reference <name>` diffs your local copy vs the bundle. The legacy `skillpack install` managed-block model was retired in v0.36.0.0; if you're upgrading from an older release, run `voltmind skillpack migrate-fence` once to strip the legacy fence and keep your existing skill rows.

To upgrade later: `voltmind upgrade` runs schema migrations + post-upgrade prompts (chunker bumps, the v0.36.2.0 ZeroEntropy switch). Always TTY-only; non-TTY upgrades skip prompts with informational stderr lines.

## 2. CLI standalone

No agent platform, just shell + MCP-aware editor.

```bash
bun install -g github:Justike001/voltmind
voltmind init --pglite
```

> **If `bun install -g` hits a postinstall error** (Bun blocks postinstall hooks in some environments), the CLI prints a recovery hint pointing at [#218](https://github.com/Justike001/voltmind/issues/218). Run `voltmind doctor` to diagnose, then `voltmind apply-migrations --yes` manually. The deterministic fallback is `git clone https://github.com/Justike001/voltmind.git ~/voltmind && cd ~/voltmind && bun install && bun link`.

The init flow detects your repo size and suggests Supabase for brains > 1000 markdown files. To switch later:

```bash
voltmind migrate --to supabase     # PGLite → Postgres
voltmind migrate --to pglite       # Postgres → PGLite (rare)
```

For shared / large / multi-machine deployments (a team or company brain with multiple users hitting one server over HTTP MCP with OAuth scoping per user), follow the dedicated walkthrough: **[Tutorial: set up VoltMind as your company brain](tutorials/company-brain.md)**.

API keys live in `~/.voltmind/config.json` (file plane) or env vars (`OPENAI_API_KEY`, `ZEROENTROPY_API_KEY`, `VOYAGE_API_KEY`, `ANTHROPIC_API_KEY`). Set via CLI:

```bash
voltmind config set zeroentropy_api_key sk-...
voltmind config set anthropic_api_key sk-ant-...
```

Common follow-ups:

```bash
voltmind import ~/my-knowledge      # bulk-import a markdown folder
voltmind sync --watch               # live-sync a git repo
voltmind autopilot --install        # Postgres/Supabase host-local daemon for nightly enrichment
```

Autopilot and its supervised worker require Postgres/Supabase. They are not
available through PGLite or remote MCP; see
[`skills/RESOLVER.md`](../skills/RESOLVER.md) and
[`docs/operations/windows-autopilot-reliability.md`](operations/windows-autopilot-reliability.md)
for the supported topology.

## 3. MCP server (any MCP client)

```bash
voltmind serve                      # stdio MCP (Claude Desktop / Code / Cursor)
voltmind serve --http               # HTTP MCP with OAuth 2.1 + admin dashboard
```

Per-client setup guides live in [`docs/mcp/`](mcp/):

- [`docs/mcp/CLAUDE_CODE.md`](mcp/CLAUDE_CODE.md)
- [`docs/mcp/CLAUDE_DESKTOP.md`](mcp/CLAUDE_DESKTOP.md)
- [`docs/mcp/CHATGPT.md`](mcp/CHATGPT.md)
- [`docs/mcp/PERPLEXITY.md`](mcp/PERPLEXITY.md)
- [`docs/mcp/DEPLOY.md`](mcp/DEPLOY.md) — production deploy patterns

The HTTP server ships with an admin SPA at `/admin`, an SSE activity feed at `/admin/events`, DCR-style client registration, scope-gated `read`/`write`/`admin` access, and rate limiting.

## Thin-client mode

Connect to someone else's brain without running a local engine:

```bash
voltmind init --mcp-only            # configures remote MCP, skips local DB
```

Useful for: team mounts, brain-as-a-service deployments, dev machines without disk space. Most local commands refuse with a paste-ready hint. See [`docs/architecture/topologies.md`](architecture/topologies.md).

## Windows release acceptance

Before calling a Windows release ready, run the real published binary through
Task Scheduler on a clean Windows account or VM. The acceptance harness
downloads `voltmind-windows-x64.exe`, verifies its SHA-256, uses a temporary
`VOLTMIND_HOME`, requires a disposable Postgres database, registers the real
task, starts it, and checks Scheduler state, Autopilot PID, heartbeat, and
database readiness:

```powershell
./scripts/windows-release-acceptance.ps1 `
  -ReleaseUrl 'https://github.com/Justike001/voltmind/releases/download/vX.Y.Z/voltmind-windows-x64.exe' `
  -ExpectedSha256 '<sha256-from-release>' `
  -DatabaseUrl 'postgresql://<disposable-user>:<password>@<host>:5432/<db>'
```

The script cleans the temporary home and scheduled task by default. Retain
the final status JSON, task XML/screenshot, Last Run Result, and log excerpt
for the release record; redact credentials and private paths. Full details are
in [windows-release-acceptance.md](operations/windows-release-acceptance.md).

The Release workflow publishes `voltmind-windows-x64.exe`. The Test workflow
independently runs the 14 Windows Autopilot adapter test files on
`windows-latest` for every push and pull request, even when the Linux test
cache is a hit.

## Verifying the install

```bash
voltmind doctor --json              # full health check
voltmind models                     # which AI models are configured for what
voltmind models doctor              # 1-token probe per configured model
```

If anything's yellow, `voltmind doctor` names the fix command in the message. Most issues are missing API keys or stale schema (`voltmind upgrade --force-schema`).
