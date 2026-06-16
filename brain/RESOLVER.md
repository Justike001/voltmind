# VoltMind Personal Brain Resolver

This is the filing authority for the Personal Brain. Before creating a page, choose exactly one primary home. Use links and frontmatter to preserve relationships without duplicating pages.

## First Rule

If the item is a derived execution/status object, file it under `state/`. Otherwise file it under a Primary Home directory.

State objects are:
- Decisions
- Commitments
- Actions
- Risks
- Derived indexes

Primary pages hold context. State pages hold structured operational status and back-links.

## Decision Tree

1. Unclassified quick capture, voice note, snippet, or temporary meeting note -> `inbox/`
2. Private daily work log, reflection, planning, blocker note, or tomorrow plan -> `daily/`
3. Named person relevant to work -> `people/`
4. Internal team, department, function, committee, or working group -> `orgs/`
5. External company, customer, supplier, partner, competitor, investor, or platform -> `companies/`
6. Long-running responsibility domain with no clear end date -> `workstreams/`
7. Bounded work unit with goal, owner, scope, status, and milestone -> `projects/`
8. Specific meeting, call, workshop, review, or sync -> `meetings/`
9. Deliverable, draft, proposal, report, design doc, plan, prompt, or memo -> `artifacts/`
10. Stable reusable concept, method, framework, or model -> `concepts/`
11. Raw possibility, product thought, thesis, bet, or observation not yet active -> `ideas/`
12. Company-wide vocabulary, ontology, or department lens definition -> `ontology/`
13. Governance protocol, privacy rule, publish contract, source-of-truth rule, approval rule -> `policy/`
14. Raw material or pointer to source material -> `sources/`
15. Proposed publishable update from Personal Brain to Team/Company Brain -> `contribution/candidates/`
16. Explicitly non-contributable private material -> `private/`
17. Dead, obsolete, or historical page -> `archive/`

## State Object Routing

1. Decision object or decision index -> `state/decisions/`
2. Promise, obligation, or commitment made by/to someone -> `state/commitments/`
3. Smallest executable task or agent execution contract -> `state/actions/`
4. Risk, blocker, concern, or watch item -> `state/risks/`
5. Derived operational view or generated index -> `state/indexes/`

## Common Tiebreakers

- Project vs Idea: if there is active work, owner, milestone, or scope, use `projects/`; otherwise use `ideas/`.
- Project vs Workstream: project has an end condition; workstream is a long-running responsibility area.
- Artifact vs Project: artifact is the deliverable; project is the coordinated work that may produce many artifacts.
- Meeting vs Source: meeting page contains analysis and candidate contributions; source page preserves transcript/raw pointer.
- Daily vs Private: daily is a dated operating log; private is a non-contributable private note.
- Company vs Org: `companies/` is external; `orgs/` is internal.
- Action vs Project: action is a concrete executable step; project holds context and coordination.
- Decision vs Meeting: meeting may mention a decision; durable decision status belongs in `state/decisions/`.
- Risk vs Open Thread: if it needs owner, sensitivity, evidence, or mitigation, promote to `state/risks/`.

## Contribution Safety

Never publish raw `daily/` or `private/` content. Create a redacted `contribution/candidates/` page first.

Use core frontmatter on every page:

```yaml
scope: private
visibility: private
sensitivity: internal
promotion: allowed
publish_level: never
source_refs: []
related_entities: []
```
