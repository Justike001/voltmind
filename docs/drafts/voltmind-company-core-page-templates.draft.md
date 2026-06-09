# Draft: VoltMind Personal Brain Init Skeleton And Page Templates

This draft defines the Personal Brain skeleton that `voltmind init` should eventually create, plus the agent-facing markdown templates for each core directory.

Design rules:

- `RESOLVER.md` is the filing authority. Read it before creating any page.
- Primary Home directories hold native knowledge objects.
- `state/` holds derived state objects and operational registries, not primary background context.
- `.system/` holds machine registries and sync/index state.
- Keep current synthesis above `<!-- timeline -->`.
- Keep evidence, transcript, raw notes, and lifecycle events below `<!-- timeline -->`.

Preferred page shape:

```markdown
---
id: page-type-slug
type: page-type
title: Page Title
owner: people/owner-slug
scope: private
visibility: private
sensitivity: internal
promotion: allowed
publish_level: never
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: active
tags: []
---

# Page Title

Current synthesized truth, status, open questions, and links.

<!-- timeline -->

## Timeline
- YYYY-MM-DD | Source - What happened.
```

## Core Frontmatter

Every page should carry the same core frontmatter block so Personal Brain pages can later become Company Brain contribution candidates without losing ownership, privacy, evidence, or graph context.

```yaml
id: page-type-slug
type: page-type
title: Page Title
owner: people/owner-slug
scope: private
visibility: private
sensitivity: internal
promotion: allowed
publish_level: never
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: active
tags: []
```

Core field meanings:

| Field | Purpose |
|---|---|
| `id` | Stable page/object identifier. Prefer `<type>-<slug>` or `<type>-YYYY-MM-DD-<slug>` for state objects. |
| `owner` | Person who owns the page or object. |
| `scope` | `private`, `team`, or `company`. |
| `visibility` | `private`, `shared`, or `restricted`. |
| `sensitivity` | `public`, `internal`, `confidential`, or `restricted`. |
| `promotion` | `allowed`, `blocked`, or `ask_each_time`. |
| `publish_level` | `never`, `candidate`, `user_approved`, `team_reviewed`, or `company_state`. |
| `source_refs` | Evidence or provenance links. |
| `related_entities` | Related people, projects, companies, systems, or state objects for graph links. |
| `created` | Page creation date. |
| `updated` | Last meaningful update date. |
| `status` | Type-specific lifecycle state. Generic values are `active`, `archived`, or `superseded`. |

## Init Skeleton

```text
voltmind/
├── RESOLVER.md
├── schema.md
├── inbox/
├── daily/
├── people/
├── orgs/
├── companies/
├── workstreams/
├── projects/
├── meetings/
├── artifacts/
├── concepts/
├── ideas/
├── policy/
├── sources/
├── contribution/
│   ├── candidates/
│   ├── published/
│   ├── rejected/
│   ├── redacted/
│   ├── reviews/
│   └── rules.md
├── private/
├── archive/
├── state/
│   ├── decisions/
│   ├── commitments/
│   ├── actions/
│   ├── risks/
│   └── indexes/
└── .system/
    ├── entity-registry.json
    ├── event-ledger.jsonl
    ├── fact-store.jsonl
    ├── relationship-graph.jsonl
    ├── task-registry.jsonl
    ├── automation-registry.jsonl
    └── sync-state.json
```

## Primary Home Directories

- `inbox/` - temporary quick capture and unclassified notes. Must be regularly resolved into a primary home.
- `daily/` - private personal work log, planning, reflection, and daily operating notes.
- `people/` - people relevant to work.
- `orgs/` - internal teams, departments, functions, committees, working groups, and durable org units.
- `companies/` - external companies, customers, suppliers, partners, competitors, investors, and platform providers.
- `workstreams/` - long-running responsibility domains without a fixed end date.
- `projects/` - bounded work units with goals, owners, scope, state, and milestones.
- `meetings/` - meeting/call/workshop records and contribution candidates.
- `artifacts/` - deliverables, drafts, proposals, reports, plans, prompts, and design docs.
- `concepts/` - reusable concepts, methods, frameworks, and models.
- `ideas/` - raw possibilities not yet active projects.
- `policy/` - Phase 0 governance protocol: privacy, publishing, sensitivity, source-of-truth, role/scope, action risk, and retention rules.
- `sources/` - raw materials or references to source materials.
- `contribution/` - candidate/promoted/rejected/redacted contribution records from Personal Brain to Team/Company Brain.
- `private/` - explicitly non-contributable private material.
- `archive/` - dead, obsolete, or historical pages.

## State Object And Registry Directories

`state/` is not a primary home. It stores structured objects extracted from primary pages for execution, review, automation, and publish workflows.

- `state/decisions/` - decision objects with status, owner, evidence, rationale, consequences, and review date.
- `state/commitments/` - promises made by or to people/teams/companies.
- `state/actions/` - smallest executable tasks with owner, due date, source refs, and promotion status.
- `state/risks/` - risk objects with owner, impact, likelihood, evidence, mitigation, scope, and sensitivity.
- `state/indexes/` - derived indexes and operational views.

`.system/` machine registries:

- `entity-registry.json` - canonical entities, aliases, external IDs.
- `event-ledger.jsonl` - immutable event stream.
- `fact-store.jsonl` - structured claims with provenance.
- `relationship-graph.jsonl` - typed edges between entities and pages.
- `task-registry.jsonl` - task/action execution index.
- `automation-registry.jsonl` - recurring automation registry.
- `sync-state.json` - import/sync checkpoints.

## People

Use `people/` for one page per employee, contractor, advisor, candidate, partner contact, or other named person relevant to company work. For internal employees, frontmatter should capture the minimum HR/operating context the company can reliably know.

```markdown
---
id: person-full-name
type: person
title: Full Name
owner: people/full-name
scope: private
visibility: private
sensitivity: internal
promotion: ask_each_time
publish_level: never
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: active
email: person@company.com
work_location: City, Country or Remote
job_title: Current title
department: Department or function
team: orgs/team-slug
manager: people/manager-slug
employment_status: active
aliases: []
tags: []
---

# Full Name

> One-paragraph work summary: what this person owns, where they fit, and when to involve them.

## Ownership And Expertise

- Durable areas of ownership.
- Systems, customers, workflows, domains, or institutional context they know well.
- Questions or decisions that should route to this person.
- Projects, processes, or surfaces they are accountable for.

## Current Work

This section indexes active work this person is currently driving or contributing to. Link to canonical project and action pages rather than duplicating their details.

- **Projects:** [[projects/slug]] - role, scope, or current milestone.
- **Actions:** [[state/actions/slug]] - concrete next step, due date, or dependency.
- **Recurring work:** Ongoing responsibilities that do not yet have a project page.

## Open Threads

This section tracks unresolved obligations, risks, decisions, and questions involving this person. Link to canonical pages whenever they exist.

- **Commitments:** [[state/commitments/slug]] - promise, due date, or expected outcome.
- **Risks:** [[state/risks/slug]] - risk they own, block, or mitigate.
- **Decisions:** [[state/decisions/slug]] - pending or recently decided item involving them.
- **Questions:** unresolved questions that do not yet deserve their own page.

## Collaboration Notes

- Work-relevant collaboration preferences, cadence, timezone constraints, review style, escalation path, or communication channel.
- Keep this factual, useful, and sourced from observed work context.
- Do not write personality judgments or speculative motivation.

## Related

- **Team:** [[orgs/team-slug]]
- **Manager:** [[people/manager-slug]]
- **Reports:** [[people/person-slug]]
- **Meetings:** [[meetings/YYYY-MM-DD-topic]]
- **Companies:** [[companies/company-slug]]

<!-- timeline -->

## Timeline

- YYYY-MM-DD | Source - Joined the company / changed role / moved team / took ownership / made a key decision / completed notable work.
```

## Orgs

Use `orgs/` for internal teams, departments, functions, committees, working groups, and durable org units. Roles live in frontmatter fields on people and org pages during MVP.

```markdown
---
id: org-team-or-department-name
type: org
title: Team Or Department Name
owner: people/owner-slug
scope: team
visibility: shared
sensitivity: internal
promotion: allowed
publish_level: candidate
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: active
leads: []
department: Parent department or function
role: Team role in the company
tags: []
---

# Team Or Department Name

> One-paragraph summary of why this org unit exists and what it owns.

## State

- **Owner:** Accountable lead.
- **Mission:** What this team is responsible for.
- **Scope:** What is in and out of scope.
- **Key interfaces:** Teams, projects, systems, or functions it coordinates with.

## Responsibilities

- Durable ownership areas.
- Recurring workflows and operating cadences.
- Decision rights and escalation paths.

## Current Priorities

- Active priorities, projects, or initiatives.
- Links to active project pages.

## Open Threads

- **Commitments:** [[state/commitments/slug]] - team-level promise or obligation.
- **Risks:** [[state/risks/slug]] - team-level blocker or concern.
- **Decisions:** [[state/decisions/slug]] - pending or recent org decision.
- **Questions:** unresolved ownership, staffing, scope, or interface questions.

## Related

- **People:** [[people/person-slug]]
- **Projects:** [[projects/project-slug]]
- **Policy:** [[policy/policy-slug]]

<!-- timeline -->

## Timeline

- YYYY-MM-DD | Source - Org change, ownership update, priority shift, or operating decision.
```

## Companies

Use `companies/` for one page per external company, customer, supplier, partner, competitor, investor, platform provider, or other organization.

```markdown
---
id: company-company-name
type: company
title: Company Name
owner: people/internal-owner-slug
scope: private
visibility: private
sensitivity: internal
promotion: ask_each_time
publish_level: never
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: active
website: https://example.com
relationship: customer | supplier | partner | competitor | investor | platform | prospect | other
key_people: []
tags: []
---

# Company Name

> What they are and why they matter to my work.

## State

- **Type:** Customer, supplier, partner, competitor, investor, platform, prospect, or other.
- **Relationship:** Current relationship context.
- **Key people:** External stakeholders with links when known.
- **Related projects:** [[projects/project-slug]]
- **Related opportunities / tickets:** ticket, CRM, sales, support, or delivery references.
- **Current status:** Active, evaluating, blocked, dormant, churned, or unknown.

## Open Threads

- **Commitments:** [[state/commitments/slug]] - promise, due date, or expected outcome.
- **Actions:** [[state/actions/slug]] - concrete next step involving this company.
- **Risks:** [[state/risks/slug]] - risk, blocker, or concern tied to this company.
- **Decisions:** [[state/decisions/slug]] - pending or recent decision involving this company.
- **Questions:** unresolved questions that do not yet deserve their own page.

<!-- timeline -->

## Timeline

- YYYY-MM-DD | Source - Meeting, account update, contract event, product signal, ticket, incident, or relationship change.
```

## Workstreams

Use `workstreams/` for long-running responsibility domains that may contain many projects and do not have a clear end date.

```markdown
---
id: workstream-workstream-name
type: workstream
title: Workstream Name
owner: people/owner-slug
scope: private
visibility: private
sensitivity: internal
promotion: allowed
publish_level: candidate
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
team: orgs/team-slug
status: active | paused | archived
tags: []
---

# Workstream Name

> Long-running responsibility area, why it matters, and what success looks like over time.

## State

- **Purpose:** Why this workstream exists.
- **Owner:** Accountable person.
- **Team:** Primary org unit.
- **Current direction:** Current strategic emphasis.

## Principles

- Durable principles, constraints, or operating beliefs for this workstream.

## Active Projects

- [[projects/project-slug]] - why it belongs in this workstream and current status.

## Risks And Opportunities

- **Risks:** [[state/risks/slug]]
- **Ideas:** [[ideas/idea-slug]]
- **Opportunities:** customer/product/process openings worth watching.

## Open Threads

- Unresolved questions, decisions, commitments, or risks that affect the whole workstream.

## Links

- **People:** [[people/person-slug]]
- **Orgs:** [[orgs/team-slug]]
- **Sources:** [[sources/source-slug]]

<!-- timeline -->

## Timeline

- YYYY-MM-DD | Source - Direction change, new project, closed project, major decision, or external signal.
```

## Projects

Use `projects/` for bounded work units with an explicit goal, owner, scope, status, and milestone. If nobody is actively pushing it yet, use `ideas/`.

```markdown
---
id: project-project-name
type: project
title: Project Name
owner: people/owner-slug
scope: private
visibility: private
sensitivity: internal
promotion: allowed
publish_level: candidate
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: proposed | active | paused | shipped | archived
my_role: owner | contributor | reviewer | observer
team: orgs/team-slug
workstream: workstreams/workstream-slug
related_people: []
related_companies: []
related_systems: []
deadline: YYYY-MM-DD
tags: []
---

# Project Name

> One-paragraph current state.

## State

- **Goal:** What outcome this project is meant to achieve.
- **Owner:** Accountable person.
- **My role:** Owner, contributor, reviewer, observer.
- **Status:** Proposed, active, paused, shipped, or archived.
- **Deadline:** Date or milestone if known.
- **Related people:** [[people/person-slug]]
- **Related companies:** [[companies/company-slug]]
- **Related systems:** systems, repos, tools, or operational surfaces.
- **Current blockers:** [[state/risks/risk-slug]]
- **Next actions:** [[state/actions/action-slug]]

## Open Questions

- Questions that block scope, design, execution, ownership, or acceptance.

## Decisions

- [[state/decisions/decision-slug]] - decision, status, and why it matters.

## Commitments

- [[state/commitments/commitment-slug]] - promise, due date, or expected outcome.

## Risks

- [[state/risks/risk-slug]] - impact, owner, and mitigation pointer.

## Links

- **Meetings:** [[meetings/YYYY-MM-DD-topic]]
- **Sources:** [[sources/source-slug]]
- **Tickets:** ticket links or IDs.
- **Docs:** [[artifacts/artifact-slug]]

<!-- timeline -->

## Timeline

- YYYY-MM-DD | Source - Milestone, decision, scope change, blocker, shipped work, or project status change.
```

## Meetings

Use `meetings/` for records of specific meetings, calls, workshops, interviews, reviews, or syncs that happened at a specific time.

```markdown
---
id: meeting-YYYY-MM-DD-slug
type: meeting
title: YYYY-MM-DD Meeting Title
owner: people/owner-slug
scope: private
visibility: private
sensitivity: internal
promotion: ask_each_time
publish_level: candidate
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: active
date: YYYY-MM-DD
attendees: []
projects: []
orgs: []
source: sources/source-slug
tags: []
---

# YYYY-MM-DD Meeting Title

> Analysis, not transcript paste: what mattered, what changed, what was decided, and what needs follow-up.

## Attendees

- [[people/person-slug]] - role in this meeting or relevant context.

## Key Decisions

- Decision made, decider, rationale, and link to `state/decisions/` page if it needs a durable record.

## Action Items

- [[state/actions/slug]] - owner, action, due date, and dependency if useful.
- If the action is too small to deserve its own page, keep it inline with owner and due date.

## Connections

- **Projects:** [[projects/slug]] - how this meeting affects the project.
- **Org:** [[orgs/slug]] - internal team or function involved.
- **Risks:** [[state/risks/slug]] - risks raised or mitigated.
- **Commitments:** [[state/commitments/slug]] - promises made or updated.

## Candidate Contributions

- [ ] Publish decision to project
- [ ] Create action item
- [ ] Promote risk to team

<!-- timeline -->

## Transcript

Paste or link the full transcript, notes, or source excerpt here. Keep this section append-only.
```

## Artifacts

Use `artifacts/` for deliverables and outputs: drafts, proposals, reports, technical plans, prompt designs, presentation outlines, research notes, and code design explanations.

```markdown
---
id: artifact-artifact-title
type: artifact
title: Artifact Title
owner: people/owner-slug
scope: private
visibility: private
sensitivity: internal
promotion: ask_each_time
publish_level: never
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: draft | active | sent | superseded | archived
artifact_type: proposal | report | draft | plan | prompt | design | memo | other
related_project: projects/project-slug
tags: []
---

# Artifact Title

> What this artifact is, who it is for, and why it exists.

## Purpose

- Intended audience.
- Intended decision, action, or outcome.

## Content

Draft, outline, memo, proposal, report, or prompt content.

## Review Notes

- Feedback, unresolved edits, approvals, or blockers.

## Links

- **Project:** [[projects/project-slug]]
- **Source:** [[sources/source-slug]]
- **Meeting:** [[meetings/YYYY-MM-DD-topic]]
- **Contribution:** [[contribution/candidates/cand-slug]]

<!-- timeline -->

## Timeline

- YYYY-MM-DD | Source - Created, revised, reviewed, sent, superseded, or archived.
```

## Concepts

Use `concepts/` for stable concepts, reusable methods, frameworks, and models. If it could become a product/project but no one is working on it, use `ideas/`.

```markdown
---
id: concept-concept-name
type: concept
title: Concept Name
owner: people/owner-slug
scope: private
visibility: private
sensitivity: internal
promotion: allowed
publish_level: candidate
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: active
aliases: []
related_workstreams: []
tags: []
---

# Concept Name

> Short definition and why this concept matters.

## Definition

- Clear explanation in reusable terms.

## Why It Matters

- How this concept helps interpret work, products, systems, people, or decisions.

## Examples

- Concrete examples, preferably linked to projects, artifacts, or sources.

## Related

- **Ideas:** [[ideas/idea-slug]]
- **Projects:** [[projects/project-slug]]
- **Artifacts:** [[artifacts/artifact-slug]]
- **Sources:** [[sources/source-slug]]

<!-- timeline -->

## Timeline

- YYYY-MM-DD | Source - Concept captured, refined, applied, challenged, or superseded.
```

## Ideas

Use `ideas/` for raw possibilities, product thoughts, theses, bets, and original observations that are not yet active projects. Preserve the user's exact phrasing when capturing original thinking.

```markdown
---
id: idea-idea-title
type: idea
title: Idea Title
owner: people/owner-slug
scope: private
visibility: private
sensitivity: internal
promotion: ask_each_time
publish_level: never
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: raw | exploring | promoted | parked | rejected
originator: people/person-slug
related_projects: []
related_workstreams: []
tags: []
---

# Idea Title

> Preserve the original thought in the user's phrasing when possible.

## Original Thought

Quote or near-verbatim capture of the original observation, thesis, bet, or product thought.

## Why It Might Matter

- Problem, opportunity, customer pain, strategic opening, or unusual observation.

## Evidence

- Supporting signals, examples, sources, or counter-signals.

## Paths Forward

- What would make this a project.
- Smallest validation step.
- Who should react to it.

## Open Threads

- Questions, objections, missing evidence, or next checks.

## Related

- **Workstreams:** [[workstreams/workstream-slug]]
- **Projects:** [[projects/project-slug]]
- **Companies:** [[companies/company-slug]]
- **Sources:** [[sources/source-slug]]

<!-- timeline -->

## Timeline

- YYYY-MM-DD | Source - Captured, discussed, validated, promoted, parked, or rejected.
```

## Daily

Use `daily/` for private personal work logs, planning, temporary thoughts, self-reflection, blockers, and tomorrow plans. Daily pages are private by default. Contribution candidates may be extracted, but raw daily text must not be published directly.

```markdown
---
id: daily-YYYY-MM-DD
type: daily
title: YYYY-MM-DD
owner: people/owner-slug
scope: private
visibility: private
sensitivity: internal
promotion: ask_each_time
publish_level: never
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: active
date: YYYY-MM-DD
tags: []
---

# YYYY-MM-DD

## Plan

- What matters today.
- Meetings or work blocks.

## Work Log

- What happened.
- Decisions noticed.
- Commitments noticed.
- Actions noticed.
- Risks noticed.

## Blockers

- Personal or work blockers.

## Candidate Contributions

- [ ] Create action item
- [ ] Promote risk to team
- [ ] Publish decision to project
- [ ] Create commitment

## Tomorrow

- What should continue tomorrow.

<!-- timeline -->

## Timeline

- HH:MM | Source - Event, thought, update, or work log entry.
```

## Policies

Use `policy/` for Phase 0 governance protocol files that agents must follow: publishing rules, privacy rules, source-of-truth rules, approval rules, redaction rules, action risk rules, and retention rules.

```markdown
---
id: policy-policy-name
type: policy
title: Policy Name
owner: people/owner-slug
scope: private | team | company
visibility: private | shared | restricted
sensitivity: public | internal | confidential | restricted
promotion: allowed
publish_level: team_reviewed
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: draft | active | superseded | archived
tags: []
---

# Policy Name

> What rule this policy establishes and why it matters.

## Rule

- The actual rule or constraint.

## Applies To

- Pages, sources, workflows, agents, teams, or contribution paths affected.

## Approval / Exceptions

- Who can approve exceptions.
- What must be checked before action.

## Examples

- Allowed.
- Not allowed.

## Related

- **Projects:** [[projects/project-slug]]
- **Contribution rules:** [[contribution/rules]]
- **Sources:** [[sources/source-slug]]

<!-- timeline -->

## Timeline

- YYYY-MM-DD | Source - Created, approved, revised, superseded, or violated.
```

## Sources

Use `sources/` for raw materials or references to raw materials: meeting transcripts, email exports, Teams threads, CRM snapshots, ERP/MES/ticket references, articles, PDFs, and API responses.

```markdown
---
id: source-source-title
type: source
title: Source Title
owner: people/owner-slug
scope: private
visibility: private | shared | restricted
sensitivity: public | internal | confidential | restricted
promotion: ask_each_time
publish_level: never
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: active
source_type: meeting_transcript | email | teams_thread | crm_record | ticket | web | pdf | api_response | other
source_url:
captured_at: YYYY-MM-DDTHH:MM:SSZ
related_pages: []
tags: []
---

# Source Title

> What this source is and what distilled pages reference it.

## Summary

- Short summary of the raw material.

## References

- Pages, state objects, or contribution candidates that cite this source.

## Raw / Pointer

Paste raw excerpt, attach path, or preserve source link/reference. Do not over-summarize here.

<!-- timeline -->

## Timeline

- YYYY-MM-DD | Source - Captured, imported, refreshed, redacted, or superseded.
```

## Contribution Candidate

Use `contribution/candidates/` for proposed publishable updates from Personal Brain to Team/Company Brain. Meeting pages are the primary source of these candidates.

```markdown
---
id: contribution-candidate-title
type: contribution_candidate
title: Candidate Title
owner: people/owner-slug
scope: private
visibility: private
sensitivity: internal | confidential | restricted
promotion: allowed
publish_level: candidate
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: active
candidate_type: decision | action | risk | commitment | project_update | company_update | other
review_status: pending_user_review | approved | rejected | redacted | published
suggested_scope: team | company
suggested_owner: people/owner-slug
publish_target:
writeback_target:
tags: []
---

# Candidate Title

## Candidate Type

Decision, action, risk, commitment, project update, company update, or other.

## Proposed Shared Summary

The cleaned summary that could be shared outside the Personal Brain.

## Original Personal Source

- personal://meetings/YYYY-MM-DD-topic
- personal://daily/YYYY-MM-DD

## Redacted Evidence

Evidence safe enough for the suggested scope.

## Related Entities

- [[companies/company-slug]]
- [[projects/project-slug]]
- [[people/person-slug]]
- ticket or CRM reference

## Suggested Scope

Team or company.

## Suggested Owner

Who should own the published object.

## Review Status

Pending user review, approved, rejected, redacted, or published.

## Publish Target

Where it should land in Team/Company Brain.

## Writeback Target

Ticket, CRM, project, or other operational system to update.

<!-- timeline -->

## Timeline

- YYYY-MM-DD | Source - Candidate created, reviewed, redacted, approved, rejected, published, or written back.
```

## Private

Use `private/` for content that must never participate in contribution workflows.

```markdown
---
id: private-private-note-title
type: private
title: Private Note Title
owner: people/owner-slug
scope: private
visibility: private
sensitivity: confidential | restricted
promotion: blocked
publish_level: never
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: active
contribution_allowed: false
tags: []
---

# Private Note Title

## Note

Private reflection, plan, or material that must not be proposed for publishing.

<!-- timeline -->

## Timeline

- YYYY-MM-DD | Source - Private update.
```

## Inbox

Use `inbox/` for temporary quick capture. Inbox pages should be resolved into a primary home or deleted.

```markdown
---
id: inbox-inbox-capture-title
type: inbox
title: Inbox Capture Title
owner: people/owner-slug
scope: private
visibility: private
sensitivity: internal
promotion: ask_each_time
publish_level: never
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: unprocessed | filed | discarded
captured_at: YYYY-MM-DDTHH:MM:SSZ
source:
tags: []
---

# Inbox Capture Title

## Capture

Raw quick capture, voice note, snippet, meeting note, or temporary thought.

## Filing Hints

- Candidate primary home.
- Related people, projects, companies, or sources.

<!-- timeline -->

## Timeline

- YYYY-MM-DD | Source - Captured, reviewed, filed, or discarded.
```

## State Decision

```markdown
---
id: decision-YYYY-MM-DD-slug
type: decision
title: decision-YYYY-MM-DD-slug
owner: people/owner-slug
scope: private | team | company
visibility: private | shared | restricted
sensitivity: internal | confidential | restricted
promotion: allowed
publish_level: never | candidate | user_approved | team_reviewed | company_state
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: proposed | accepted | superseded | rejected
related_projects: []
review_date: YYYY-MM-DD
tags: []
---

# decision-YYYY-MM-DD-slug

## Decision

The decision in one or two sentences.

## Status

Proposed, accepted, superseded, or rejected.

## Scope

Private, team, or company.

## Owner

Decision owner or accountable person.

## Evidence

- **Meeting:** [[meetings/YYYY-MM-DD-topic]]
- **Project:** [[projects/project-slug]]
- **Source:** [[sources/source-slug]]

## Rationale

Why this decision was made or proposed.

## Consequences

Expected impact, tradeoffs, and follow-up obligations.

## Review Date

When this decision should be revisited.

<!-- timeline -->

## Timeline

- YYYY-MM-DD | Source - Proposed, accepted, superseded, reviewed, or rejected.
```

## State Commitment

```markdown
---
id: commitment-YYYY-MM-DD-slug
type: commitment
title: commitment-YYYY-MM-DD-slug
owner: people/owner-slug
scope: private | team | company
visibility: private | shared | restricted
sensitivity: internal | confidential | restricted
promotion: allowed
publish_level: never | candidate | user_approved | team_reviewed | company_state
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: open | fulfilled | changed | broken | obsolete
promisor: people/person-slug
promisee: people/person-slug
related_project: projects/project-slug
due: YYYY-MM-DD
writeback_target:
tags: []
---

# commitment-YYYY-MM-DD-slug

## Commitment

Who promised what to whom.

## Parties

- **Promisor:** [[people/person-slug]]
- **Promisee:** [[people/person-slug]]
- **Related project:** [[projects/project-slug]]

## Due

Due date or expected window.

## Status

Open, fulfilled, changed, broken, or obsolete.

## Evidence

- [[meetings/YYYY-MM-DD-topic]]
- [[sources/source-slug]]

## Visibility

Private, shared, or restricted.

## Writeback

- **Team Brain:**
- **Ticket:**
- **CRM:**

<!-- timeline -->

## Timeline

- YYYY-MM-DD | Source - Created, changed, fulfilled, broken, published, or written back.
```

## State Action

Actions are executable state objects. They should be small enough to execute or track, but structured enough for a deterministic scanner and an agent runtime to know when to do nothing, when to remind, when to ask for confirmation, and when to request approval.

Action execution modes:

- `manual` - only a human can do it.
- `agent_assisted` - agent can prepare work, but a human performs the final act.
- `agent_executable` - agent can execute once when explicitly triggered.
- `scheduled_agent` - agent can run on a schedule.
- `watch_agent` - agent watches a condition and executes or reminds when it becomes true.

Automation fields should be read by a cheap deterministic scanner before any LLM/runtime is invoked.

```markdown
---
id: action-YYYY-MM-DD-slug
type: action
title: action-YYYY-MM-DD-slug
owner: people/owner-slug
scope: private | team | company
visibility: private | shared | restricted
sensitivity: internal | confidential | restricted
promotion: allowed
publish_level: never | candidate | user_approved | team_reviewed | company_state
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: open | in_progress | done | blocked | canceled
due: YYYY-MM-DD
priority: low | medium | high
related_people: []
related_project: projects/project-slug
related_projects: []
related_workstream: workstreams/workstream-slug
related_systems: []
context_refs: []
automation:
  eligible: true
  mode: manual | agent_assisted | agent_executable | scheduled_agent | watch_agent
  runtime: codex | browser | email | vault | api
  trigger: manual_checkbox | cron | due_time | condition
  run_at:
  schedule:
  condition:
  risk_level: low | medium | high | restricted
  requires_confirmation: true
  requires_approval: false
allowed_tools: []
blocked_tools: []
max_autonomy: draft_only | single_step | multi_step | autonomous_until_blocked
agent_contract:
  objective:
  context_refs: []
  output_target:
    type:
    path:
  success_criteria: []
writeback:
  on_success: []
  on_failure: []
tags: []
---

# action-YYYY-MM-DD-slug

## Action

One concrete executable task. Keep it short.

## Execution

- **Mode:** manual, agent_assisted, agent_executable, scheduled_agent, or watch_agent.
- **Trigger:** manual checkbox, cron, due time, or condition.
- **Runtime:** codex, browser, email, vault, or api.
- **Risk level:** low, medium, high, or restricted.
- **Confirmation:** whether the user must confirm before execution.
- **Approval:** whether explicit approval is required before execution.

## Agent Contract

- **Objective:** What the agent should accomplish.
- **Context refs:** Pages the agent must read before acting.
- **Output target:** Where the result should go.
- **Success criteria:** Observable conditions that mean the action succeeded.

## Context

- **People:** [[people/person-slug]]
- **Project:** [[projects/project-slug]]
- **Workstream:** [[workstreams/workstream-slug]]
- [[meetings/YYYY-MM-DD-topic]]
- [[sources/source-slug]]

## Tools

- **Allowed:** tools the agent may use.
- **Blocked:** tools the agent must not use.

## Writeback

- **On success:** timeline updates, status updates, generated artifact links, or external writeback targets.
- **On failure:** status update, error log, risk memory, or request for human intervention.

## Status

Open, in progress, done, blocked, or canceled.

<!-- timeline -->

## Timeline

- YYYY-MM-DD | Source - Created, assigned, blocked, completed, canceled, or published.
```

## State Risk

```markdown
---
id: risk-YYYY-MM-DD-slug
type: risk
title: risk-YYYY-MM-DD-slug
owner: people/owner-slug
scope: private | team | company
visibility: private | shared | restricted
sensitivity: internal | confidential | restricted
promotion: ask_each_time
publish_level: never | candidate | user_approved | team_reviewed | company_state
source_refs: []
related_entities: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: open | monitoring | mitigated | closed | obsolete
related_project: projects/project-slug
related_customer: companies/company-slug
tags: []
---

# risk-YYYY-MM-DD-slug

## Risk

What might go wrong.

## Impact

What happens if this risk materializes.

## Likelihood

Low, medium, high, or unknown. Include why.

## Related Project / Customer / System

- [[projects/project-slug]]
- [[companies/company-slug]]
- system or ticket reference

## Evidence

- [[meetings/YYYY-MM-DD-topic]]
- [[sources/source-slug]]

## Owner

Who owns watching or mitigating this risk.

## Mitigation

What can reduce likelihood or impact.

## Scope

Private, team, or company.

## Sensitivity

Internal, confidential, or restricted.

<!-- timeline -->

## Timeline

- YYYY-MM-DD | Source - Raised, updated, mitigated, escalated, published, or closed.
```
