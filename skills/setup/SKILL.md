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
- Verify with `voltmind doctor` and `voltmind status`.
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
voltmind doctor
voltmind status
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
voltmind embed --stale
voltmind search "<known term>"
voltmind query "<known question>"
```

For an existing registered source:

```bash
voltmind sources list
voltmind sources current
voltmind sync --no-pull --no-embed
voltmind embed --stale
```

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
Health: <doctor/status summary>
Import: <pages imported or skipped>
Next: capture, import, sync, embed, search/query
```

## Anti-Patterns

- Asking for Supabase credentials during MVP setup.
- Suggesting `gbrain` commands.
- Treating advanced inherited setup docs as active instructions.
- Ending setup before verifying `voltmind doctor` and at least one retrieval
  command when data was imported.

