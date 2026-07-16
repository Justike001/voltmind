# Install VoltMind

VoltMind is a local-first knowledge brain. Start with PGLite; move to
Postgres/Supabase only when you need a shared HTTP brain or the supervised
Minions/Autopilot runtime.

## 1. Source checkout

```bash
git clone https://github.com/Justike001/voltmind.git
cd voltmind
bun install
bun link
voltmind init
```

Verify the installation:

```bash
voltmind doctor --fast --json
voltmind status --json
voltmind capture "installation check"
voltmind search "installation check"
```

For agent-operated setup, follow [INSTALL_FOR_AGENTS.md](../INSTALL_FOR_AGENTS.md).

## 2. Global install

```bash
bun install -g github:Justike001/voltmind
voltmind init
```

If a global install is inconvenient, use `bun link` from a source checkout.
The CLI binary and all skill/runtime paths use the VoltMind names documented in
`AGENTS.md`; do not copy legacy GBrain environment variables or dotfiles.

## 3. Import and retrieval

```bash
voltmind import ./notes --no-embed
voltmind sync --no-pull --no-embed
voltmind search "a keyword"
voltmind query "a question about the notes"
voltmind embed --stale
```

Use `voltmind put` or `voltmind capture` for explicit writes. Add a
`[Source: ...]` citation to every durable fact and sync after the write.

## 4. Configuration and providers

```bash
voltmind config set <key> <value>
voltmind providers
voltmind storage
```

Keep API keys in the host environment or config plane. Never put secrets in
Markdown, skill files, issue reports, or MCP payloads.

## 5. MCP

```bash
voltmind serve
voltmind serve --http --port 7331
```

The stdio server is suitable for a local MCP client. HTTP MCP is intended for
Postgres/Supabase hosts and supports the allowlisted operations only. Inspect
the public tools with `voltmind --tools-json`.

## 6. Postgres/Supabase and Autopilot

Use Postgres/Supabase when you need a durable queue, multiple clients, or a
supervised worker. Configure the database through VoltMind config or the host
environment, then check:

```bash
voltmind doctor --json
voltmind autopilot --install
voltmind autopilot --status --json
```

Autopilot is host-local and is not exposed through remote MCP. PGLite supports
manual and inline maintenance, but not the supervised Minions worker.

On Windows use exactly:

```text
Task Scheduler → voltmind autopilot → supervised voltmind jobs work → Postgres
```

Do not register a second scheduled `voltmind jobs work` task. See
[windows-autopilot-reliability.md](operations/windows-autopilot-reliability.md)
for pause/start, heartbeat, lock, and verification semantics.

### Release acceptance on a clean Windows machine

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

## 7. Updating

From a source checkout:

```bash
git pull --ff-only
bun install
voltmind apply-migrations
voltmind doctor --fast
```

Read the applicable files under `skills/migrations/` before running a costly
backfill. Keep a backup of a Postgres database before destructive migrations.

## 8. Troubleshooting

```bash
voltmind doctor --fast --json
voltmind status --json
voltmind health
```

If a Windows build cannot replace `bin\\voltmind.exe`, stop the running
VoltMind process and retry the build; this is an executable file lock, not a
TypeScript failure.
