---
name: cold-start
version: 2.0.0
description: |
  VoltMind MVP day-one data bootstrapping for a new local brain. Sequences
  offline exports and local files into a useful first dataset without online
  API access, background agents, ClawVisor, Gmail/Calendar/Twitter live
  connectors, archive-crawler, or meeting-ingestion.
triggers:
  - "cold start"
  - "fill my brain"
  - "bootstrap brain"
  - "import my data"
  - "day one"
  - "get started"
  - "what should I import first"
  - "populate brain"
  - "now what?"
  - "离线导入"
  - "初始化数据"
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
  - sync_brain
  - sources_add
  - sources_list
  - get_stats
  - get_health
  - put_raw_data
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
  - meetings/
  - daily/
  - media/
  - conversations/
  - sources/
  - concepts/
  - ideas/
---

# Cold Start - VoltMind MVP Day-One Bootstrap

Use this skill after VoltMind is installed and the user asks what to import
first. The MVP route is local-first and consent-gated: import only files the
user points to or offline exports the user has already downloaded.

## MVP Boundary

Use `voltmind`, `VOLTMIND_HOME`, `.voltmind-source`, and `voltmind.yml`.
Do not use inherited `gbrain`, `GBRAIN_*`, `.gbrain`, or `gbrain.yml` names.

Allowed runtime surface:

- `voltmind status`, `voltmind health`, `voltmind doctor --fast`
- `voltmind sources list`, `voltmind sources add <id> --path <path>`
- `voltmind import <path> --no-embed`
- `voltmind sync --source <id> --no-pull --no-embed`
- `voltmind embed --stale`
- `voltmind search`, `voltmind query`, `voltmind get`, `voltmind put`
- `voltmind link`, `voltmind backlinks`, `voltmind graph`
- `voltmind timeline-add`, `voltmind timeline`
- `voltmind stats`
- MCP `put_raw_data` / `get_raw_data` through `voltmind call` when preserving
  raw provenance is useful.

Frozen in MVP:

- Online API capture through ClawVisor, Gmail, Google Contacts, Google Calendar,
  Drive, Twitter/X live API, or any other remote connector.
- Direct OAuth/token setup for the agent.
- `archive-crawler`, `meeting-ingestion`, `migrate`, `extract links`,
  `extract timeline`, autonomous enrichment, ambient entity detection,
  cron/autopilot/live scheduler setup, Minion submit/worker flows.
- Bulk import that sends private data to an embedding provider without the
  user's explicit approval.

Offline-export only:

- Google Contacts: import a user-provided CSV/vCard export only.
- Google Calendar: import a user-provided ICS/CSV export only.
- Gmail/email: import user-provided mbox/EML/Takeout text only, after sampling.
- Twitter/X: import a downloaded archive only.
- ChatGPT/Claude/Perplexity: import downloaded exports only.
- Meeting transcripts: import local transcript files only.
- File archives: scan user-provided local folders manually; no crawler skill.

## Contract

- Ask before every phase. Present the source, expected privacy exposure, and
  whether embeddings will be generated.
- Prefer `--no-embed` for first-pass imports. Run `voltmind embed --stale` only
  after the user approves sending imported text to the configured embedding
  provider.
- Import a small sample first when the source may contain personal data.
- Preserve source attribution on durable pages with `[Source: ...]`.
- Check VoltMind before creating entity pages: `voltmind search "name"` then
  `voltmind query "what do we know about name"` when embeddings exist.
- After writing pages on disk, sync with `voltmind sync --no-pull --no-embed`
  or re-run `voltmind import <path> --no-embed`.
- Track progress under `VOLTMIND_HOME/cold-start-state.json` if a session spans
  multiple phases. Do not write progress to `~/.gbrain`.

## Prerequisites

Run these first:

```bash
voltmind status
voltmind health
voltmind doctor --fast
voltmind sources list
```

If doctor reports provider or schema problems, route to `skills/setup/SKILL.md`
or `skills/maintain/SKILL.md` before importing real data.

## Priority Stack

| Priority | MVP source | Route |
|---|---|---|
| 1 | Existing markdown / Obsidian export | `voltmind import <path> --no-embed` |
| 2 | Conversation exports | Import selected local export files after sampling |
| 3 | Contacts export | Convert CSV/vCard into reviewed people pages |
| 4 | Calendar export | Convert ICS/CSV into daily or meeting pages |
| 5 | Email export | Import sampled mbox/EML/text threads only |
| 6 | Meeting transcripts | Import local transcript files only |
| 7 | Twitter/X archive | Import downloaded archive excerpts only |
| 8 | File archive | Manual scan and selected local imports only |

## Phase 0: Consent And Source Selection

Ask the user which source to start with and whether embeddings are allowed.
Good first choices:

1. A markdown/Obsidian folder.
2. A ChatGPT/Claude export folder.
3. A small contacts/calendar export.
4. A single meeting transcript folder.

Do not ask for OAuth tokens, API keys, dashboard tokens, or live connector
credentials.

## Phase 1: Local Markdown Or Obsidian Export

Use this for any folder already containing markdown.

1. Inspect file count locally.
2. Register a source if the folder should become a recurring local source:

```bash
voltmind sources add <source-id> --path <absolute-path> --federated
```

3. Import without embeddings:

```bash
voltmind import <absolute-path> --no-embed
voltmind stats
voltmind search "<known phrase from the import>"
```

4. If the user approves embeddings:

```bash
voltmind embed --stale
voltmind stats
```

For Obsidian wikilinks, import the markdown as-is in MVP. Do not use inherited
`migrate`; fix link structure manually or in a later phase.

## Phase 2: Conversation Exports

Supported in MVP only as local downloaded files.

- ChatGPT export folders / JSON files.
- Claude export files.
- Perplexity exports or copied markdown/text.

Process:

1. Sample a few conversations and ask whether to continue.
2. Import only conversations rated notable by the user or clearly useful.
3. File by primary subject when writing durable pages. Use `conversations/`
   when the conversation itself is the artifact.
4. Preserve exact user wording when it is the source of an idea.
5. Add `[Source: conversation export, file/path/date]`.

## Phase 3: Contacts Export

Supported in MVP only from local CSV or vCard exports.

Rules:

- Skip automated senders and records without a useful name.
- Search before creating a page.
- Create or update `people/` pages only after the user approves the sample
  format.
- If an organization is present, create or update `companies/` only when the
  entity is notable.

Sample quality gate: after 5 contacts, show the user target slugs and sample
frontmatter before continuing.

## Phase 4: Calendar Export

Supported in MVP only from local ICS/CSV exports.

Rules:

- Prefer recent windows first, such as the last 90 days.
- Create `daily/` pages for date-centered logs.
- Create `meetings/` pages only for events with real notes, decisions, or
  follow-ups.
- Use `timeline-add` on people/project pages only for notable events.
- Do not set up live calendar sync or cron in MVP.

## Phase 5: Email Export

Supported in MVP only from user-provided mbox/EML/text exports.

Import strategy:

- Start with sent mail, starred/flagged mail, or threads the user names.
- Skip newsletters, marketing, noreply/no-reply, automated notifications,
  GitHub/Jira/Linear noise, and raw calendar invites.
- Preserve only the signal: decisions, commitments, relationship context,
  project history, and original wording worth keeping.

Do not bulk import a whole mailbox without a sample review and explicit user
approval.

## Phase 6: Meeting Transcripts

Supported in MVP only from local transcript files.

Rules:

- Prefer complete transcript text over vendor summaries.
- Create a meeting page only if the transcript has meaningful decisions,
  commitments, ideas, or context.
- Update people/project pages only when the evidence is notable and cited.
- Do not delegate to inherited `meeting-ingestion`.

## Phase 7: Twitter/X Archive

Supported in MVP only from a downloaded archive or manually exported text.

Rules:

- Prefer original posts, threads, quote commentary, and bookmarks the user says
  are important.
- Skip likes by default.
- File under `media/` only when the source format is the unifying frame; prefer
  `concepts/`, `ideas/`, `people/`, or `companies/` when there is a clear
  primary subject.
- Do not call live Twitter/X APIs in MVP.

## Phase 8: File Archives

Supported in MVP only as manual local-folder review.

Do a scan-first pass by listing candidate files and asking the user which subset
to import. Do not delegate to inherited `archive-crawler`.

Prefer:

- User-authored writing.
- Project notes.
- Meeting notes and transcripts.
- High-signal PDFs or text exports that the user explicitly selects.

Avoid:

- Application folders, installers, caches, build output, dependency folders.
- Private material the user has not explicitly approved for import.

## Post-Phase Verification

After every phase:

```bash
voltmind stats
voltmind search "<known phrase>"
voltmind query "what did we just import?"
```

If pages were written on disk rather than through `voltmind put`, run:

```bash
voltmind sync --no-pull --no-embed
```

If embeddings were approved:

```bash
voltmind embed --stale
```

## Anti-Patterns

- Asking the user for OAuth tokens, API keys, ClawVisor tokens, or live
  connector credentials.
- Calling Gmail, Google Calendar, Google Contacts, Twitter/X, Drive, or other
  online APIs from this skill.
- Delegating to inherited `archive-crawler`, `meeting-ingestion`, `migrate`, or
  extract/backfill commands.
- Bulk importing private exports without a sample review.
- Running embeddings on private imports before the user approves provider
  exposure.
- Creating pages for automated senders, newsletters, notifications, installers,
  caches, or dependency folders.
- Treating `conversations/` or `media/` as dumping grounds when a clear primary
  subject belongs under `people/`, `companies/`, `projects/`, `concepts/`, or
  `ideas/`.

## Output Format

After each phase:

```text
PHASE N COMPLETE: <source>

Pages imported: N
Pages created: N
Pages updated: N
Links added: N
Timeline entries added: N
Embeddings: skipped | refreshed

Sample:
- <slug> - <why it was created or updated>

Next recommended phase: <phase>. Ready to continue?
```

## Tools Used

- `search` / `voltmind search` - dedupe and verify keyword retrieval.
- `query` / `voltmind query` - hybrid lookup after embeddings exist.
- `get_page` / `voltmind get` - inspect existing pages before merging.
- `put_page` / `voltmind put` - create or update reviewed pages.
- `add_link` / `voltmind link` - create explicit entity relationships.
- `add_timeline_entry` / `voltmind timeline-add` - record notable events.
- `sync_brain` / `voltmind sync --no-pull --no-embed` - refresh the index after
  disk writes.
- `sources_add` / `voltmind sources add` - register a local source folder.
- `sources_list` / `voltmind sources list` - inspect configured sources.
- `get_stats` / `voltmind stats` - check page/chunk/link/timeline counts.
- `get_health` / `voltmind health` - check embedding and freshness health.
- `put_raw_data` / `voltmind call put_raw_data` - preserve raw evidence when a
  reviewed page needs provenance.
