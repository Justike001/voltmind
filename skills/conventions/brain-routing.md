# Brain Routing Convention — VoltMind MVP

Cross-cutting rules for which local brain and source an operation targets.
Applies to every MVP skill that reads or writes VoltMind pages.

## MVP Model

- **Brain** = the local PGLite-backed VoltMind database resolved from
  `VOLTMIND_HOME` or `~/.voltmind`.
- **Source** = the registered repo/content source inside that local database,
  resolved by `--source`, `VOLTMIND_SOURCE`, `.voltmind-source`, source
  `local_path`, or the default source.

Multi-brain mounts, remote artifact brains, cross-brain federation, and
thin-client routing are frozen for MVP.

## Source Resolution

Use the active source resolved by the runtime. Highest priority wins:

1. Explicit `--source <id>` CLI flag.
2. `VOLTMIND_SOURCE` environment variable.
3. `.voltmind-source` file in the current directory or an ancestor.
4. Registered source whose `local_path` contains the current directory.
5. Configured default source.
6. The seeded `default` source.

Run this before a write if the target source matters:

```bash
voltmind sources current
```

## When To Switch Source

Switch source when:

- The user explicitly names a source.
- The working directory belongs to a registered source.
- The imported/captured content clearly belongs to a specific local repo.

Do not switch source when:

- The user's intent is general retrieval across the local knowledge base.
- You are unsure. Stay with the resolved default and ask before writing.

## Brain Rules

Do not use `--brain`, `GBRAIN_BRAIN_ID`, `.gbrain-mount`, mounts, or cross-brain
fan-out in MVP. If the user asks for team/multi-brain behavior, say it is not
included in VoltMind MVP yet and offer to capture/import into the local brain.

## Citation With Source Context

When search/query/get results expose `source_id`, include it in citations:

- `[default:people/alice]`
- `[notes:projects/voltmind-runtime]`

Do not invent source ids. If a result has no source id, cite the page slug and
the visible source/provenance text in the page.

## Decision Table

| Situation | Brain | Source |
|---|---|---|
| User asks a general question | local PGLite brain | resolved default |
| User is inside a registered notes repo | local PGLite brain | path-resolved source |
| User says "save this to source X" | local PGLite brain | `X`, if it exists |
| User imports a folder | local PGLite brain | explicit `--source` or runtime default |
| User asks for team/cross-brain search | frozen | explain MVP boundary |

## Anti-Patterns

- Using old `GBRAIN_*`, `.gbrain`, or `gbrain.yml` names.
- Silently switching to a remote or team brain.
- Writing to an ambiguous source without confirmation.
- Treating inherited cross-brain docs as active MVP instructions.

