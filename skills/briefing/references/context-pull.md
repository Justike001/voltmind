# Context pull: current VoltMind MCP contract

Read this before composing every briefing. Examples are operation arguments;
use the installed tool names/schema, not a guessed `Search` alias or CLI flags
inside MCP JSON. Source routing belongs to the authenticated connection unless
the advertised operation explicitly supports a selector.

## 0. Pin identity and coverage

Call `whoami({})` when available. Check `owner_source_id`, `allowed_sources`,
and `federated_read` against the intended Host connection and user's source.
Access to several sources is not a request to report all of them. For this
single-source briefing, use a connection scoped to that source. If the token is
federated and an operation cannot narrow its scope, do not call that operation
and filter unrelated private data afterward; disclose the routing gap. Never
invent `source_id` arguments on search/list/get/timeline.

For a configured CLI fallback, verify the brain/source resolver and pass
`--brain <resolved-brain> --source <resolved-source>` explicitly on reads.
Do not silently fall back to a local empty DB when the Host is unavailable.
Unknown source identity blocks dependent retrieval, not a coverage explanation.

Keep a compact evidence ledger: brain/source/slug, updated_at, effective event
date, owner/status/deadline, evidence link, retrieval cutoff and limitations.
Reuse loaded pages by composite identity. A list row may omit source_id in the
current runtime: bind it only to a verified single-source connection; otherwise
leave identity unresolved. Do not manufacture freshness dates or page URLs.

## 1. Pre-briefing pulls

Run the available, source-safe pulls before drafting. Independent reads may be
batched; resolve identity before dependent page reads. Failure of an optional
pull does not block the core inventory.

| Pull | Calls and handling |
|---|---|
| Personal context | `search({query: "current priorities preferences commitments", limit: 10})`; if insufficient, `query({query: "What are my current priorities, preferences and prior commitments?"})`, then read discovered pages. Also honor configured agent preferences. Remote recall only exposes world-visible facts; absence does not mean no personal preferences. |
| Hot-memory pulse | `recall({since: "<ISO cutoff>", include_pending: true, limit: 100})` if available. Use last successful report's cutoff only when explicitly available; otherwise use a disclosed trailing 24-hour window. Group returned facts by entity; report kind, notability and confidence when meaningful, retaining fact provenance. A 100-row result may be truncated; counts are for the returned sample. |
| Corrections | Prefer current pages and their timelines. `recall({since: "<ISO cutoff>", supersessions: true, limit: 100})` is conditional on the installed service verifying visibility and source confinement for that branch. The current local handler's supersessions branch does not apply the normal visibility filter, so skip it on remote connections. Never present expired facts as current. |
| Salience | `get_recent_salience({days: 7, limit: 10})` only if available, authorized, and confined to the intended source. Current implementation is admin-scoped and not source-filtered: skip it for a source-only Host briefing. Use recent scoped pages/timelines as an explicitly qualitative activity fallback, not an emotional salience score. |
| Anomalies | `find_anomalies({since: "<YYYY-MM-DD>", lookback_days: 30})` has the same admin/unscoped restriction. Skip on a source-only connection; do not invent statistical anomalies from a few updates. Note its UTC date semantics when available. |
| Open loops | Retrieve canonical commitments/actions plus their evidence and timelines. The current operations contract has no `waiting` tool; do not issue `voltmind waiting` from an upstream example. If a future connector provides evidenced loop rows, check its schema and freshness before use; label stale rows and report the documented sync remedy without running sync. |

`recall` does not accept `query`, `rollup`, `pending`, or `since_last_run` in
the current MCP contract. Compute a sample rollup locally. Do not advance a
recall cursor, run dream, sync, enrich, or repair sources during a briefing.
Pending consolidation is a footer for the operator, not a maintenance trigger.
Ordinary read operations may maintain runtime retrieval telemetry; the skill's
read-only contract prohibits semantic writes and workflow/cursor mutations.

## 2. Retrieve today's work AND older open work

Use active schema types, not directory paths as guessed type names. Inspect
known schema context or returned page types first. For each applicable category
(meetings, projects/workstreams/deals, actions, commitments, risks):

1. `list_pages({type: "<actual type>", sort: "updated_desc", limit: 100})`
   for the inventory, without an updated_after restriction. An old open promise
   remains relevant even if it has not changed for months.
2. Supplement with keyword `search({query: "<topic or entity>", limit: 20,
   offset: 0})`, then semantic `query` if needed: active deals/project milestones,
   meetings this week, pending commitments/follow-ups, overdue work and blockers.
   Use the user's vocabulary and known aliases; broad queries are discovery,
   not proof of completeness. Keyword search supports offset; increment by
   requested page size when continuing that query, deduplicate, stop on a short
   or empty page. Label budget-limited searches as partial.
3. `get_page({slug: "<canonical slug>"})` verifies each selected item's compiled
   truth, ownership, deadline, evidence and state. `get_timeline({slug: "..."})`
   verifies revisions, completion/cancellation and history. Its only current
   argument is slug: filter returned events locally, not with invented dates.
4. Follow unresolved prerequisites and linked older commitments even outside
   the recent window. Stop expansion once the item has sufficient evidence;
   keep unresolved links in coverage gaps rather than recursively reading the DB.

Current `list_pages` caps limit at 100 and exposes NO offset/cursor, status,
owner, deadline or prefix filter. Never claim to exhaust pagination with it.
At the cap, use supported type/tag partitions or scoped keyword searches to
improve coverage, disclose any remaining gap, and do not loop the same request.
Increasing limit beyond 100 or using updated_after cannot recover old omitted
open work. Apply owner/status/deadline filtering after page verification.

## 3. Meeting prep, changes, and freshness

- After brain lookup, refresh the day's calendar through an authorized connector
  when available. A meeting page is context, not proof an event is still on.
- For each attendee: search exact name/known alias, query if unresolved, read
  the identified person page and recent timeline. Summarize role, relationship,
  recent interactions and meeting-linked obligations. Explicitly flag missing
  pages or ambiguous names; do not enrich or create prep pages automatically.
- Pull `list_pages({updated_after: "<24h ISO cutoff>", sort: "updated_desc",
  limit: 100})` for changes and `list_pages({type: "person", sort:
  "updated_desc", limit: 10})` for people in play if that type exists. Read
  relevant timelines to explain what changed, using a seven-day activity window.
  Updated timestamps alone cannot tell what changed; without a baseline, say so.
- Use page timestamps to flag stale evidence relevant to today's meetings,
  deadlines and commitments (30+ days is a default warning, not proof of error).
  `get_health` is admin-scoped and unscoped in the current runtime; do not use it
  for this source-only report. Avoid dumping all stale pages or active people.

Before drafting, check that every category was attempted or marked unavailable,
older open work was searched, and each factual item has traceable evidence.
If output limits truncate a page/timeline, retrieve a supported narrower view
or report the missing evidence. Preserve the evidence ledger instead of loading
every raw transcript into the context window.
