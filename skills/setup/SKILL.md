---
name: setup
version: 2.0.0
description: Set up VoltMind MVP with Bun and local PGLite storage.
triggers:
  - "set up voltmind"
  - "initialize voltmind"
  - "initialize brain"
  - "voltmind setup"
tools:
  - get_stats
  - get_health
  - run_doctor
  - sync_brain
  - put_page
mutating: true
---

# Setup VoltMind

Set up VoltMind MVP as a local-first knowledge base. The supported MVP storage
path is PGLite under `VOLTMIND_HOME` or `~/.voltmind`.

## Contract

- Install and run through Bun.
- Initialize local PGLite storage with `voltmind init`.
- Verify core setup with `voltmind status`, `voltmind health`, and one
  retrieval command after data is imported.
- Run `voltmind doctor --fast` as a diagnostic readout. During the MVP freeze it
  may still report inherited resolver or skill archive issues; do not treat
  those as storage initialization failure unless status/health/runtime commands
  also fail.
- Keep setup on MVP commands only.

## Install

Canonical Bun install once the GitHub repo is published:

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun install -g github:Justike001/voltmind
voltmind --help
```

Local development install:

```bash
git clone https://github.com/Justike001/voltmind.git ~/voltmind
cd ~/voltmind
bun install
bun link
voltmind --help
```

No-link development execution:

```bash
bun run src/cli.ts --help
bun run src/cli.ts init
```

## Initialize

```bash
voltmind init
voltmind status
voltmind health
voltmind providers list
voltmind doctor --fast
```

Config and data names:

- Home env: `VOLTMIND_HOME`
- Default home: `~/.voltmind`
- Config file: `voltmind.yml`
- Source env: `VOLTMIND_SOURCE`
- Source dotfile: `.voltmind-source`

Do not read or write old `GBRAIN_*`, `.gbrain`, or `gbrain.yml` names.

## First Import

```bash
voltmind import /path/to/notes --no-embed
voltmind search "<known term>"
```

Only run embedding or LLM-backed query checks after an embedding/model provider
is configured and reachable:

```bash
voltmind embed --stale
voltmind query "<known question>"
```

For an existing registered source:

```bash
voltmind sources list
voltmind sources current
voltmind sync --no-pull --no-embed
voltmind embed --stale
```

## Phase C-D-E Agent Setup

Use these phases when installing agent instructions into a project.

### Phase C.5: Windows/PGLite migrations and jobs visibility

Run the idempotent migration runner once, then verify the local runtime and job
readouts:

```bash
voltmind apply-migrations --yes
voltmind status
voltmind health
voltmind jobs stats
```

Do not run `voltmind autopilot --install` on Windows/PGLite. The inherited
autopilot installer has macOS launchd, Linux systemd, ephemeral-container, and
Linux crontab targets, but no Windows service target. PGLite also uses an
exclusive local file lock, so separate worker/supervisor flows are outside the
MVP public route.

### Phase D: Brain-first protocol

Inject the VoltMind lookup protocol into `AGENTS.md` or the equivalent agent
context:

1. `voltmind search "name"` for fast keyword lookup.
2. `voltmind query "what do we know about name"` for hybrid lookup when
   embeddings are configured.
3. `voltmind get <slug>` for direct page reads.
4. Grep only if VoltMind returns zero results and the file may sit outside the
   indexed brain.

After creating or editing brain pages on disk, run:

```bash
voltmind sync --no-pull --no-embed
```

Refresh embeddings later with:

```bash
voltmind embed --stale
```

### Phase E: Production guide

Point agents at `docs/GBRAIN_SKILLPACK.md` as an inherited architecture
reference. Translate examples to VoltMind and keep only the MVP-safe patterns:
read before responding, write after learning, cite every durable fact, and
follow `skills/conventions/quality.md`.

Do not activate ambient entity detection, autonomous cron schedules, autopilot,
or Minion submit/worker flows in the Windows/PGLite MVP.

## Frozen Setup Paths

Do not guide MVP users through Supabase, remote Postgres, thin-client MCP-only
setup, multi-brain mounts, cloud file storage, autopilot, dream cycles, Minion
workers, or search-mode cost matrices. Those inherited flows are frozen until a
later phase.

## Output Format

```text
VOLTMIND SETUP COMPLETE
Storage: PGLite
Home: <resolved VOLTMIND_HOME or ~/.voltmind>
Config: voltmind.yml
Health: <status/health summary>
Doctor: <doctor --fast diagnostic summary, including any frozen-skill warnings>
Import: <pages imported or skipped>
Next: capture, import, sync, embed, search/query
```

## Anti-Patterns

- Asking for Supabase credentials during MVP setup.
- Suggesting `gbrain` commands.
- Treating advanced inherited setup docs as active instructions.
- Treating inherited resolver/skill archive warnings as PGLite init failure.
- Ending setup before verifying `voltmind status`, `voltmind health`, and at
  least one retrieval command when data was imported.
