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

- Setup/runtime: `init`, `config`, `storage`, `sources`, `status`, `doctor`,
  `apply-migrations`.
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
- **Inspect tools:** `voltmind --tools-json`
- **Check health:** `voltmind status`, `voltmind doctor --fast`, `voltmind health`

## Before shipping

Use the focused MVP gate first:

```bash
bun run typecheck
bun run build
bun test test/cli-help-discoverability.test.ts test/mvp-surface.test.ts test/mcp-tool-defs.test.ts test/operations-descriptions.test.ts
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
