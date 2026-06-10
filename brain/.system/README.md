# System

Machine-owned registries and sync state.

Files:
- `entity-registry.json`
- `event-ledger.jsonl`
- `fact-store.jsonl`
- `relationship-graph.jsonl`
- `task-registry.jsonl`
- `automation-registry.jsonl`
- `sync-state.json`

Rules:
- Do not store narrative knowledge here.
- Agents may read these for routing, sync, graph, and execution state.
- Writes should be structured and append-safe where possible.

