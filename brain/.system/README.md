# .system

Machine-readable local registries for VoltMind Personal Brain.

- `policy-config.json` - publish levels, sensitivity levels, and action risk enums.
- `entity-registry.json` - canonical entities, aliases, and external IDs.
- `event-ledger.jsonl` - append-only event stream.
- `fact-store.jsonl` - structured claims with provenance.
- `relationship-graph.jsonl` - typed edges between entities and pages.
- `task-registry.jsonl` - task/action execution index.
- `automation-registry.jsonl` - recurring automation registry.
- `sync-state.json` - import/sync checkpoints.

Agents may read these files for routing and policy context. Runtime-owned
registries should be updated through VoltMind commands when those commands exist.
