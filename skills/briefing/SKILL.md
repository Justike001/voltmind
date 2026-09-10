---
name: briefing
description: Compile or refresh today's actionable report across meetings, projects, tasks, and commitments, including after ingest. Daily owns journaling; schedule-actions owns execution arrangements.
triggers:
  - "daily briefing"
  - "morning briefing"
  - "today brief"
  - "what's happening today"
  - "今日要事"
  - "当日任务报告"
  - "今天有什么要紧事"
  - "刷新今日报告"
tools:
  - search
  - query
  - get_page
  - list_pages
  - get_timeline
mutating: false
---

# Briefing — Today's Actionable Report

## Contract

- Produce a current prioritized view of all known important work for the day
  within the sources checked, not just the latest ingest summary.
- Cover meetings, approaching project milestones, actions, both directions of
  commitment, and blockers requiring attention today. Explain why each matters
  today and what to do next.
- Cite each factual item with `[Source: brain:source:slug, updated DATE]` and a
  usable page/evidence link. Use returned source identities. Label recommended
  priorities and next steps as suggestions, not confirmed commitments.
- Read-only by default: no status changes, new actions, messages, scheduling, or
  saved pages. Explicit save requests use reports plus active vault filing and
  privacy policy; never overwrite the user's daily journal.
- Disclose missing coverage, stale information, conflicts, and unknown dates.
  An unavailable calendar is not an empty calendar.

> **Brain-first:** Read `skills/brain-ops/SKILL.md` and
> `skills/conventions/brain-routing.md` before context loading. Check the brain
> before external APIs. Resolve the local vault through its configured private
> environment setting; never infer it from repository examples.

## Phases

### 1. Establish date and scope

Resolve the user's timezone and current local date; show timezone and generation
time. If unavailable, disclose the environment-timezone assumption. Today spans
local midnight to the next midnight, not the last 24 hours. Recompute the date
at generation if ingest crossed midnight. Default deadline lookahead is seven
calendar days; longer-range work qualifies only if it needs attention today.

Resolve the user from configured context; unknown ownership remains unknown.
Enumerate relevant authorized brain/source scopes and disclose unchecked scopes.
Do not silently broaden access or publish a mixture of team/private information.
Ingest's changed pages and receipt failures are a freshness overlay, not the
complete set of today's work.

### 2. Collect candidates with coverage

Use Brain-First Lookup for entities/topics (search → query → known-page read,
stopping when sufficient). For the daily inventory, use supported scoped page
listing/filtering, exhaust pagination, and inspect dates, owner, and current
status. If date filters are unavailable, filter the scoped inventory locally.
Use only supported operations/flags. Top-k semantic search supplements the
inventory; it cannot establish completeness.

| Source | Candidates and context |
|---|---|
| Calendar and `meetings/` | Today's occurrences, objective, time, attendees, prep, reschedules and cancellations |
| `projects/`, `workstreams/` | Active milestones in the lookahead, overdue delivery, dependencies needing work today; include active deals where that schema exists |
| `state/actions/` | User-owned or user-blocking open tasks due/scheduled today, overdue, or prerequisites for upcoming delivery |
| `state/commitments/` | Promises by/to the user, delivery evidence, due and follow-up dates |
| `state/risks/`, related timelines | Blockers, pending decisions and unresolved threads affecting today |

Read current canonical pages and their evidence before trusting summaries.
In client-first mode, read handed-off local action Markdown and cited raw evidence
before any DB/MCP action index. Include locally durable changes whose sync is
pending and label that limitation; stale remote state cannot replace newer local
evidence. Other knowledge retains the normal brain-first lookup/fallback rules.
Legacy `ops/tasks` is an optional compatibility source only when present; canonical
actions remain authoritative. Deduplicate overlapping legacy entries.

After brain lookup, refresh today's calendar through an available authorized
connector when needed. Resolve recurring-event exceptions and paginate supported
results. If unavailable, present known meetings with their freshness and an
explicit calendar coverage gap. Transcript mentions do not prove an occurrence.
Load attendee brain context and meeting-related open threads for useful prep.

Record per-source cutoffs and coverage. Failed reads, limits, missing permissions,
and timeouts mean partial coverage, not zero items. Deliver useful findings without
unbounded retries. Do not claim exhaustive coverage if enumeration was incomplete.

### 3. Reconcile, select, and prioritize

Resolve revisions by stable identity and explicit effective dates. Cancellation,
completion, or revised deadlines supersede older evidence; ingestion time alone
does not establish truth. Exclude completed/cancelled work from open lists but
show material removals in changes. Conflicting evidence remains visibly unresolved.

Preserve date precision: date-only deadlines stay date-only, without an invented
execution hour. Resolve relative dates against the source timestamp/timezone.
Unknown dates are not automatically overdue. Separate delivery deadlines from
execution appointments: a missed appointment does not prove a broken promise.
Past meetings today may be marked ended, but attendance/outcomes require evidence.

Include today's meetings/prep, open due-today and overdue work, future deadlines
requiring action today, and undated blockers with demonstrated impact today.
Exclude unrelated recent updates, high-mention people and the general backlog.
Flag stale evidence according to operational relevance; silence is not completion.

Split commitments into **I owe others** and **Others owe me**. Show promisor,
recipient, deliverable, due date, fulfillment evidence, and next follow-up.
Never assign another person's promise to the user or treat a proposal as a promise.
Unknown owner/direction goes under needs confirmation.

Deduplicate by brain + source + canonical identity and explicit relationships.
An action fulfilling a commitment on a project is one primary work item with
context links, not three tasks. Cross-reference elsewhere without double counting.
Similar titles alone are insufficient to merge identities.

Rank by hard timing, delay consequences, dependency impact and preparation lead
time, respecting explicit priorities. Lead with up to three priorities but retain
all known urgent/today items in details. For upcoming milestones show remaining
calendar days, blockers and today's recommended step. Label uncertain lead time.

### 4. Compose and refresh

Use the user's language. Each item includes owner, due/event time (or unknown),
status, why today matters, next step and evidence. Meetings are chronological;
surface known overlaps and deadline/execution conflicts.

Render one report per user-visible ingest request/batch, even with zero actions
or no new signal. Same-day refreshes recompute the current view and add a short
changes section; retain the complete current report. Compare only against an
available prior report or explicit ingest revisions. Without a baseline, describe
observed ingest changes without claiming a full diff. No-change runs still return
the report with a no-material-change note.

Optional brain pulse belongs after today's work, only when relevant. It must not
delay the report or launch maintenance. Do not use cursor-advancing
`recall --since-last-run` in this read-only workflow; use supported read-only
retrieval instead.

## Output Format

```text
Today's report — YYYY-MM-DD (timezone), generated HH:MM
Coverage: sources checked, data cutoffs, material gaps

Top priorities (up to 3)
- Recommended step — why today, owner, deadline, evidence

Meetings today
- Time / meeting / status — objective, prep, attendees, conflicts, evidence

Approaching project deadlines
- Project / milestone / due / days remaining — blocker, today's step, evidence

Today's tasks and overdue work
- Action / owner / due or scheduled time / status — next step, evidence

Commitments
- I owe others: recipient / deliverable / due / status / next step / evidence
- Others owe me: promisor / deliverable / due / status / follow-up / evidence

Changes from ingest or refresh
- Added, revised, completed, cancelled, or no material change

Needs confirmation / coverage gaps
- Unknown or conflicting fact and practical impact
```

For empty sections distinguish checked-and-empty from unavailable. Explain
coverage in ordinary language; omit tool logs and retrieval mechanics.

## Anti-Patterns

- Reporting only newly ingested tasks or the first page of search results.
- Letting scheduling interviews postpone today's report.
- Treating inferred owners, tentative dates, or mentions as confirmed facts.
- Repeating one obligation as separate project/action/commitment tasks.
- Claiming complete coverage when sources are missing.
- Automatically saving, sending, scheduling, or changing operational state.

## Tools Used

- search / query: discover brain context before external reads.
- list_pages: scoped inventory with supported filters and pagination.
- get_page / get_timeline: verify current state, evidence, and revisions.
- Authorized calendar connector when available: refresh today's occurrences.
