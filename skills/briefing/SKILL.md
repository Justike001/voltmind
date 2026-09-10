---
name: briefing
description: Independently compile requested or scheduled daily briefings from current and historical Host source context across meetings, projects, tasks, and commitments. Not an automatic ingest completion step.
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
  - whoami
  - recall
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

## Invocation

Run on an explicit briefing request or a separate scheduled reporting task.
Ingest returns its own receipt and does not load or invoke briefing automatically.
A request explicitly asking for both may run briefing after ingest completes.
For scheduler setup, use
[the Desktop schedules prompt](../../docs/prompts/voltmind-setup-and-desktop-schedules.zh-CN.md).
Daily owns journaling; schedule-actions owns execution arrangements.

## Phases

### 1. Establish date and scope

Resolve the user's timezone and current local date; show timezone and generation
time. If unavailable, disclose the environment-timezone assumption. Today spans
local midnight to the next midnight, not the last 24 hours. Recompute the date
at generation if ingest crossed midnight. Default deadline lookahead is seven
calendar days; longer-range work qualifies only if it needs attention today.

Resolve the user from configured context; unknown ownership remains unknown.
Pin the configured Host connection and the user's intended source. Verify MCP
identity/scope before retrieval; access to multiple sources is not a request to
report all of them. Broader reports require explicitly requested scopes.
Ingest's changed pages and receipt failures are a freshness overlay, not the
complete set of today's work.

### 2. Collect candidates with coverage

Read [context-pull.md](references/context-pull.md) completely and execute its
source preflight, pre-briefing pulls and historical retrieval sequence before
drafting. It maps actual MCP operations, optional capabilities and limitations.
Use Brain-First Lookup for entities/topics (search → query → known-page read,
stopping when sufficient). Build a scoped inventory plus targeted historical
searches. Current list_pages caps at 100 and has no pagination; never invent
cursors, deadline filters or source selectors. Top-k search cannot establish
completeness. Mark capped inventories partial and inspect dates/owner/status
on the retrieved pages.

| Source | Candidates and context |
|---|---|
| Calendar and `meetings/` | Today's occurrences, objective, time, attendees, prep, reschedules and cancellations |
| `projects/`, `workstreams/` | Active milestones in the lookahead, overdue delivery, dependencies needing work today; include active deals where that schema exists |
| `state/actions/` | User-owned or user-blocking open tasks due/scheduled today, overdue, or prerequisites for upcoming delivery |
| `state/commitments/` | Promises by/to the user, delivery evidence, due and follow-up dates |
| `state/risks/`, related timelines | Blockers, pending decisions and unresolved threads affecting today |

Read current canonical pages and their evidence before trusting summaries.
Independent scheduled reports retrieve Host history without an ingest handoff
or loading ingest references. If newer local evidence is explicitly available,
read those exact pages and their raw evidence as a freshness overlay and label
pending sync. Do not assume local changes are remotely visible, or let an
overlay replace historical Host retrieval. Other knowledge follows the normal
brain-first lookup/fallback rules.
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
Keep unrelated updates and the general backlog out of today's action list.
Relevant high-activity people and material changes may appear in brief context
sections without becoming invented tasks.
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

Render one report per explicit request or scheduled run, even with zero actions
or no new signal. Same-day refreshes recompute the current view and add a short
changes section; retain the complete current report. Compare only against an
available prior successful report or explicit revisions. Without a baseline,
describe trailing 24-hour observed updates without claiming a full diff.
No-change runs still return
the report with a no-material-change note.

Lead with a short Brain pulse when verified corrections affect today's decisions,
then top priorities. Group available new facts and top mentions from the retrieved
sample, retaining provenance and meaningful kind/notability/confidence. Include
relevant activity, people in play and anomalies only from a supported detector.
Optional unavailable pulls must not delay today's work. Pending consolidation
is a footer, not a maintenance trigger. Do not use cursor-advancing
`recall --since-last-run`; follow the source-safe alternatives in context-pull.

## Output Format

```text
Today's report — YYYY-MM-DD (timezone), generated HH:MM
Coverage: sources checked, data cutoffs, material gaps

Brain pulse (when available)
- Material corrections / new facts / top mentions with evidence and window

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

Recent changes (24h, or verified prior-report cutoff)
- Added, revised, completed, cancelled, or no material change

People in play / relevant activity / anomalies (when available)
- Context affecting today's work, evidence, freshness

Stale context / pending consolidation (when available)
- Relevant stale evidence and impact; returned pending count

Needs confirmation / coverage gaps
- Unknown or conflicting fact and practical impact
```

For empty sections distinguish checked-and-empty from unavailable. Explain
coverage in ordinary language; omit tool logs and retrieval mechanics.

## Anti-Patterns

- Auto-invoking briefing from ingest or depending on its conversation context.
- Reporting only recent updates while missing older open work.
- Treating capped listings as exhaustive or copying unsupported upstream flags.
- Letting scheduling interviews postpone today's report.
- Treating inferred owners, tentative dates, or mentions as confirmed facts.
- Repeating one obligation as separate project/action/commitment tasks.
- Claiming complete coverage when sources are missing.
- Automatically saving, sending, scheduling, or changing operational state.

## Tools Used

- search / query: discover brain context before external reads.
- whoami: verify authenticated source boundaries before reads.
- recall: optional hot facts; follow visibility restrictions in context-pull.
- list_pages: capped scoped inventory with supported type/tag/update filters.
- get_page / get_timeline: verify current state, evidence, and revisions.
- Authorized calendar connector when available: refresh today's occurrences.
