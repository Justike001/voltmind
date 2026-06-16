# VoltMind Personal Brain Index

This index is a human and agent map for the Personal Brain. It should be generated or refreshed from the folder structure, not treated as the only source of truth.

## Primary Home

| Directory | Purpose |
|---|---|
| `inbox/` | Temporary quick capture and unclassified material. |
| `daily/` | Private daily work log, planning, blockers, and reflection. |
| `people/` | People relevant to work. |
| `orgs/` | Internal teams, departments, functions, and working groups. |
| `companies/` | External companies, customers, suppliers, partners, competitors, investors, and platforms. |
| `workstreams/` | Long-running responsibility domains. |
| `projects/` | Bounded work with goal, owner, scope, state, and milestone. |
| `meetings/` | Meeting records, analysis, and candidate contributions. |
| `artifacts/` | Deliverables, drafts, proposals, reports, prompts, plans, and design docs. |
| `concepts/` | Reusable methods, concepts, frameworks, and models. |
| `ideas/` | Raw possibilities not yet active projects. |
| `ontology/` | Control-plane vocabulary and department lens definitions. |
| `policy/` | Phase 0 governance protocol: privacy, publishing, sensitivity, source-of-truth, role/scope, action risk, and retention rules. |
| `sources/` | Raw materials or pointers to raw materials. |
| `contribution/` | Candidate/review/published/rejected/redacted promotion records. |
| `private/` | Material that must never participate in contribution workflows. |
| `archive/` | Dead, obsolete, or historical pages. |

## State Objects

| Directory | Purpose |
|---|---|
| `state/decisions/` | Decision objects with owner, status, evidence, rationale, and review date. |
| `state/commitments/` | Promises and obligations with parties, due date, status, and writeback. |
| `state/actions/` | Small executable tasks and agent execution contracts. |
| `state/risks/` | Risks with impact, likelihood, owner, mitigation, scope, and sensitivity. |
| `state/indexes/` | Derived operational indexes and generated views. |

## System Registries

| File | Purpose |
|---|---|
| `.system/entity-registry.json` | Canonical entities, aliases, and external IDs. |
| `.system/event-ledger.jsonl` | Immutable event stream. |
| `.system/fact-store.jsonl` | Structured claims with provenance. |
| `.system/relationship-graph.jsonl` | Typed edges between pages/entities. |
| `.system/task-registry.jsonl` | Detected task/action execution events. |
| `.system/automation-registry.jsonl` | Scheduled/watch automation registry. |
| `.system/policy-config.json` | Structured policy enums for publish levels, sensitivity, and action risk. |
| `.system/sync-state.json` | Import and sync checkpoints. |

## Promotion Flow

`daily/` or `meetings/` -> `contribution/candidates/` -> review -> `contribution/published/` or `contribution/rejected/` or `contribution/redacted/` -> optional writeback to Team/Company Brain or external system.
