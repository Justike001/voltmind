---
name: cold-start
version: 2.0.0
description: |
  Day-one data bootstrapping for a new VoltMind brain. Sequences the highest-
  leverage Microsoft sources first, then optional user-provided local exports
  and markdown sources, to go from empty brain to useful brain in one session.
  Use when a user has just finished VoltMind setup and asks "now what?"
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
  - "初始化数据"
  - "冷启动"
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
  - sync_brain
  - search_file_refs
  - list_page_file_refs
  - attach_file_refs
  - file_ref_materialize
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
  - meetings/
  - daily/
  - sources/teams/
  - sources/
  - projects/
  - concepts/
  - state/indexes/
---

# Cold Start — Microsoft-First Day-One Brain Bootstrapping

> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md) for the lookup chain (search → query → get_page → external).

You have a working VoltMind brain. Search works. Now what?

An empty brain is a static database. A brain with your meeting history, active
email threads, Teams conversations, recurring collaborators, projects, decisions,
and commitments is a **live context membrane** that makes every future
interaction smarter. This skill sequences the highest-leverage Microsoft sources
to get you from zero to useful in one session.

## Contract

- Every import phase is gated on user consent (ask-user pattern) before
  proceeding.
- **Microsoft source access stays inside the connected app tools.** The agent
  never asks the user for raw OAuth tokens, Microsoft Graph tokens, cookies, or
  exported secrets.
- The VoltMind MVP cold start uses three live connector source families:
  Outlook Calendar, Outlook Email, and Microsoft Teams.
- Optional offline phases may ingest user-provided local exports or local
  markdown directories through the public VoltMind import/write surface.
- Each phase is independently valuable — the user can stop after any phase and
  still have a useful brain.
- Progress is tracked in one local Markdown manifest under `state/indexes/` so
  interrupted sessions can resume without a competing JSON cursor.
- Entity detection and cross-linking run on every import, not as a separate
  pass.
- Teams and Outlook imports retain every validated SharePoint/OneDrive or
  mapped shared-drive file reference (attachments, inline links, explicit
  mentions, and recognized `Z:\...`/UNC paths). References are metadata-only
  by default; the connector or local mapping is used later only when a user
  asks to inspect the file.
- Every durable fact written to VoltMind needs a `[Source: ...]` citation.

## Prerequisites

- VoltMind installed and initialized (`voltmind status`, `voltmind health`,
  `voltmind doctor --fast`).
- Embeddings configured if the user wants semantic `query`; keyword `search`
  works without embeddings.
- Microsoft Teams, Outlook Email, and Outlook Calendar connectors are available
  to the agent session.
- The user has explicitly approved which account/mailbox/calendar/team scope to
  inspect.

## The Priority Stack

Data sources ranked by **information density x ease of import**. The default
phase order stays consent first, then Microsoft connectors, then optional local
imports. If the user already has local exports or a notes vault ready, Phase 5
or Phase 6 may be pulled forward after explicit approval.

| Priority | Phase | Source | Why | Runtime path | Time | Pages Created |
|----------|-------|--------|-----|--------------|------|---------------|
| 1 | 1 | Outlook Calendar (last 90 days) | Fastest map of people, meetings, projects, recurring work | Outlook Calendar connector + VoltMind page writes | 10-15 min | 30-90 daily/meeting/entity updates |
| 2 | 2 | Outlook Email (smart sample) | Relationship context, active threads, commitments, org chart signals | Outlook Email connector + VoltMind page writes | 20 min | 30-150 thread/entity/project updates |
| 3 | 3 | Microsoft Teams (recent chats/channels) | Decisions, coordination, informal context, open loops | Microsoft Teams connector + VoltMind page writes | 20 min | 20-100 conversation/project/entity updates |
| 4 | 4 | Cross-source reconciliation | Turns separate imports into one merged people/project graph | `voltmind search`, `voltmind get`, `voltmind put`, `voltmind link`, `voltmind timeline-add` | 10-30 min | Mostly updates |
| 5 | 6 | Existing Markdown / Obsidian | Highest bulk leverage when the user already has structured notes | `voltmind import`, `voltmind extract`, `voltmind embed` after approval | 10-60 min | 100-10,000+ imported pages |
| 6 | 5 | Conversation exports | Original thinking and research history, but requires user-provided files | local export staging + `voltmind import` or reviewed page writes | 20-60 min | 10-300 conversation/concept/project updates |

Generic web research, file/archive crawlers beyond local markdown import,
ambient social crawlers, autonomous ingestion, and future non-Microsoft live
connectors are outside the MVP cold-start route. Add them later only when their
runtime and privacy boundaries are explicitly enabled.

## Phase 0: Microsoft Connector Scope And Consent

> **Safety boundary:** A cold start can touch deeply personal work context.
> Before reading source data, tell the user exactly which Microsoft surfaces
> will be inspected, the time window, and whether durable pages will be written.

Ask for explicit approval for each source:

1. Outlook Calendar window, usually the last 90 days.
2. Outlook Email sampling rules, usually sent mail, flagged/starred mail, and
   active threads.
3. Microsoft Teams scope, usually recent 30-90 days of selected chats/channels.

Do NOT ask the user for raw Microsoft tokens. If connector auth is missing,
ask the user to connect/re-authenticate the app connector rather than providing
secrets in chat.

### If the user declines a source

Skip that source and proceed with the remaining approved phases. Do not attempt
to infer declined content from another source. Tell the user:

> "No problem. We'll skip that Microsoft source and bootstrap from the sources
> you approved. You can connect it later and resume cold start from that phase."

## Phase 1: Outlook Calendar (Last 90 Days)

**Meeting history with attendee context.** Calendar events reveal who the user
meets with, how often, and in what context. It is the fastest way to seed people,
companies, projects, and meeting pages without reading message bodies first.

### Fetch events

Use Outlook Calendar connector actions, not raw Graph tokens.

Recommended scope:

- Last 90 days for history.
- Next 14 days for near-term context.
- Include subject, time, organizer, attendees, location, online meeting links,
  and body preview when available.
- Include recurring instances, not just series masters.

### Brain structure

Follow the three-tier calendar architecture:

```text
daily/calendar/
├── calendar-log.md              <- compiled truth: patterns, key people
├── YYYY/
│   ├── YYYY-MM.md               <- monthly summary
│   └── YYYY-MM-DD.md            <- daily event log
meetings/
├── YYYY-MM-DD-{meeting-slug}.md <- only for notable meetings
```

Notable meeting pages should follow `skills/meeting-ingestion/SKILL.md` in
calendar-seeded mode. Calendar metadata can seed the meeting index, attendees,
timeline, and graph links; it must not invent decisions, action items, risks,
or project state when no transcript or notes are available.

### Entity enrichment

For each event with attendees:

1. Look up each attendee in VoltMind:
   `voltmind search "name"` then `voltmind query "what do we know about name"`
   when embeddings exist.
2. If an attendee appears in 3+ meaningful events, create or update a
   `people/` page.
3. If an attendee domain or organization is clear and notable, create or update
   a `companies/` page.
4. Add a timeline entry for notable events:
   `voltmind timeline-add people/person-slug YYYY-MM-DD "... [Source: Outlook Calendar, event title, YYYY-MM-DD]"`
5. Link attendees who repeatedly appear in the same meeting context.

### Filtering rules

**Auto-skip:**

- Holidays, reminders, focus blocks, lunch, travel buffers, private personal
  events without user approval.
- Meetings with no attendees and no useful context.
- Recurring utility blocks that do not reveal relationships or projects.

**Always consider:**

- Meetings with external attendees.
- Meetings with 3+ attendees.
- Recurring 1:1s.
- Board, customer, partner, hiring, planning, and incident meetings.
- Events whose title reveals a project, decision, deadline, or relationship.

### Quality gate

After processing 5-10 representative events, pause and show the user:

- sample `daily/calendar/YYYY-MM-DD` entry
- sample `people/` update
- sample meeting page, if any
- skipped-event categories

Ask:

> "This is what calendar cold-start pages look like. Continue with the rest of
> the window, or adjust the threshold first?"

## Phase 2: Outlook Email (Smart Sample, Not Bulk Import)

**Relationship context and active threads.** Email reveals organizational
relationships, commitments, decisions, and communication patterns. Do not import
the whole mailbox. Import the **signal**.

### Strategy: smart sampling

Start with:

1. **Sent mail, last 30 days** — who the user actively communicates with.
2. **Flagged/starred/important emails** — user-curated signal.
3. **Threads with 3+ replies** — active conversations worth tracking.
4. **Emails involving people already found in Calendar or Teams** — enrichment,
   not cold import.
5. **Emails with attachments, SharePoint/OneDrive links, or mapped-drive
   paths** — capture the validated file identity, current display/relative
   path, and safe web URL on the thread page. Resolve mapped-drive paths to a
   logical `root_key + relative_path` on the thin client. Do not
   download or parse the file during cold start.

### Processing

For each selected thread:

1. **Thread summary** — what is the thread about, what changed, what is open?
2. **Entity detection** — people, companies, projects, concepts mentioned.
3. **Commitments and actions** — who owes what, by when, with source citation.
4. **Relationship context** — communication pattern, role, tone, importance.
5. **Project context** — update `projects/` when the thread advances a project.
6. **Timeline entries** — add only notable events, decisions, or commitments.

### Filtering rules

**Auto-skip:**

- noreply@, no-reply@, notifications@, support@, mailer-daemon@
- newsletters, marketing, vendor drip campaigns
- Unsubscribe-heavy senders (marketing)
- GitHub/Jira/Linear/system/Instagram notifications unless the user explicitly asks
- raw calendar invites already represented in Calendar phase
- teams message remind already represented in Teams phase
- VPMS update
- New Hire Announcement / Work Anniversary / Birthday Announcement / Promotion Announcement / Employee Spotlight

**Always import or review:**

- Direct emails from people already in the brain
- Emails the user sent that contain decisions, strategy, original thinking, or
  commitments
- Flagged/starred/important threads
- Threads with named projects, customers, partners, candidates, vendors, or
  deadlines

### Quality gate

After 5 threads, pause and show:

- one people page update
- one project page update
- one skipped-thread example
- one extracted action/commitment

Ask:

> "This is the signal/noise threshold I'm using for email. Continue, narrow to
> sent-only, or change the filter?"

## Phase 3: Microsoft Teams (Recent Chats And Channels)

**Coordination context and informal truth.** Teams often contains the working
state that never makes it into email: decisions, blockers, quick clarifications,
owners, and project momentum.

### Fetch Teams context

Use the Teams connector only. Recommended starting scope:

- Recent 30 days for high-volume environments.
- Recent 90 days for smaller teams.
- Selected chats/channels named by the user.
- Include message sender, timestamp, thread/channel, replies, reactions only
  when they carry meaning, linked meeting context when available, and every
  attachment, inline SharePoint/OneDrive link, mapped-drive path, or explicitly
  mentioned file.

### Fetch loop for active chats

The Microsoft Teams MCP message listing surface may cap high-volume history
reads. A single response is not enough evidence that a busy chat, group chat,
or channel is complete.

For every approved chat/group chat/channel:

1. Create or resume the local cold-start manifest before any connector call.
   Record the approved scope, connector capabilities, and phase progress in
   its frontmatter.
2. Read the newest available batch with `top=50` (or lower) and treat any
   `[start, end)` values as manifest bookkeeping, not as a connector-enforced
   historical query, unless the connector exposes a verified upper time bound
   or continuation cursor.
3. Before each read, select the next eligible manifest work unit and set it to
   `reading`. Persist raw evidence before marking the unit `captured`.
4. If a read reaches the observed result cap (currently 99), preserve the
   newest captured batch, mark the older logical range `blocked` with
   `last_error: blocked_by_connector_pagination`, and do not declare that
   history complete. Do not create smaller historical child windows: a
   newest-first capped API with only `sent_after` cannot be paged backwards.
5. Deduplicate by the stable key `teams:<container-id>:<message-id>`.
6. On HTTP 429, set the work unit to `rate_limited`, record the retry time, and
   continue with unrelated eligible work. Do not classify it as `no_signal`.
7. Continue across approved containers until each has either a newest batch
   captured, is rate-limited, or is explicitly blocked by pagination. Do not
   claim the requested historical range is covered when a container saturated.
8. Transition each captured container to ongoing incremental ingest. Set its
   `incremental_high_watermark` to the newest durably captured message time and
   use `sent_after = incremental_high_watermark - overlap` on later reads.
   If a later read saturates, record the unrecoverable gap and move the high
   watermark to the newest returned message so the feed remains live; do not
   attempt historical recovery.

For a capped newest-first connector, cold start is a latest-available sample,
not historical recovery. The manifest must make this explicit for every active
room. Ongoing incremental ingest—not cold-start backfill—is the reliable path
for subsequently arriving messages.

### Participant profile enrichment

For each approved chat or group chat, use the Teams/Microsoft connector API
surface, where available, to fetch participant/contact profile metadata before
writing people pages. Capture only fields actually returned by the connector;
do not infer missing values from message text.

Preferred `people/` frontmatter fields:

```yaml
email: alice@example.com
chat: alice@example.com
mobile: "+10000000000"
work_location: Example Office
job_title: Example Role
department: Example Department
teams_id: "optional-teams-id"
```

Profile fields should be merged into the same person page that Calendar and
Email identities use. Search first with `voltmind search "<email or display
name>"`, read the known page with `voltmind get <slug>` when found, and preserve
existing source-backed values unless the Microsoft profile gives a clearer
current value. Every durable profile fact needs a source citation such as
`[Source: Microsoft Teams profile/contact, 2026-06-11]`.

When the connector only returns a subset, write only that subset. For example,
Teams user resolution may return display name, email/user principal name, and
AAD user id but not mobile, work location, job title, or department. In that
case, fill `email`, `chat`, and `teams_id`, leave the unavailable fields null,
and note the connector limitation in the page body instead of inferring missing
profile data from message text.

### Strategy: reconstruct conversations, not message dumps

Do not create one page per message. Group messages into meaningful episodes:

- one decision thread
- one project update
- one incident/blocker discussion
- one customer/account thread
- one planning or coordination burst

### Processing

For each meaningful Teams episode:

1. **Identify the room** — chat, channel, team, project, or meeting context.
2. **Fetch participant profiles** — enrich `people/` frontmatter with returned
   email, chat identity, mobile, work location, job title, department, and Teams id
   when available.
3. **Extract decisions** — decisions are first-class facts.
4. **Extract actions** — owner, action, deadline, source message.
5. **Extract entities** — people, companies, projects, concepts.
6. **Update pages** — people pages get cited profile and relationship deltas;
   project/company pages get cited status and decision deltas.
7. **Create conversation pages** only when the thread itself is the durable
   artifact.
8. **Back-link entities** — every mentioned entity with a page links back to
   the Teams-derived page or update.

### External file references

Before importing mapped-drive references, verify the current thin client has a
root mapping. If it does not, chain into `ingest`'s mapped shared-drive setup
and run `voltmind client-roots add/test` locally. Do not ask the Host to resolve
the client's drive letter.

For each Teams or Outlook item, pass file references through the connector
relay as `file_refs`. The relay/SharePoint connector must resolve the stable
`(tenant_id, drive_id, item_id)` identity for Microsoft files when possible.
For RaiDrive or another mapped shared drive, normalize the configured local or
UNC root to a cross-user `root_key` and store only the remainder as
`relative_path`. This normalization happens on the thin client; do not send the
current user's `Z:\...` or username-specific UNC to the host. Use `file_id`
when the NAS/SMB layer exposes one.
Capture `attachment`, `inline_link`, and `mentioned` occurrences separately so
one file can be traced to multiple messages or threads.

The default cold-start behavior is reference-first:

- write the file name, display/relative path, safe web URL or logical root,
  service, and availability;
- never persist OAuth tokens, cookies, signed URLs, or download payloads;
- materialize a file only after the user asks for analysis, then store the
  extracted Markdown under `artifacts/microsoft/...` or
  `artifacts/filesystem/...`, with the observed eTag/version when available.

When a file is moved or renamed, update the existing identity rather than
creating a second file record. A single connector permission failure is not a
tombstone; only an explicit deletion event marks a reference missing.

### Filtering rules

**Auto-skip:**

- Emoji-only reactions
- "thanks", "done", "sounds good" without new context
- automated app/bot notifications
- status chatter with no durable fact
- duplicate messages already captured from email/calendar

**Always import or review:**

- decisions
- blockers and risks
- commitments with owners
- project status changes
- customer/partner context
- people relationship signals
- original ideas or strategy expressed by the user

### Quality gate

After 3-5 Teams episodes, pause and show:

- one project update
- one people/company relationship update
- one action or commitment
- one skipped low-signal thread

Ask:

> "This is how Teams signal is being compressed. Continue with this threshold,
> or make it stricter?"

## Phase 4: Cross-Source Reconciliation

The value of cold start is not three separate imports. The value is connecting
Calendar, Email, and Teams into one coherent working memory.

### Reconcile people

For every person seen across sources:

1. Merge names, emails, Teams display names, and calendar identities.
2. Keep source-specific identifiers in the page only when useful.
3. Summarize the relationship: how the user knows them, how often they interact,
   active projects, and recent notable context.
4. Add source citations for every durable fact.

For `people/` pages, keep `Ownership And Expertise` narrow. Only write durable
ownership, expertise, institutional context, or routing knowledge there. Active
projects/actions belong in `Current Work`; unresolved follow-ups belong in
`Open Threads`; casual Teams chatter, tool tips, greetings, birthday/social
messages, one-off admin/OA logistics, and already-answered questions should stay
out of the person page unless they change durable work context.

### Reconcile projects

For every project or workstream:

1. Calendar gives cadence and participants.
2. Email gives formal decisions and commitments.
3. Teams gives informal status, blockers, and working context.
4. The project page should end with current state, open loops, key people, and
   recent timeline.

### Reconcile meetings

Only create meeting pages for meetings with durable signal:

- decisions
- commitments
- customer/partner context
- strategic discussion
- incident/postmortem value
- recurring meeting whose pattern matters

Otherwise keep the event as a daily/calendar entry and timeline signal.

## Phase 5: Conversation Exports (ChatGPT / Claude / Perplexity)

**Your thinking, captured.** AI conversation exports reveal what the user
was researching, building, and thinking about. This is original thinking
preserved in dialog form.

### Supported formats

- **ChatGPT:** Settings → Data Controls → Export → `conversations.json`
- **Claude:** Download from claude.ai conversation history
- **Perplexity:** Export from settings

### Runtime boundary

This phase is available only when the user provides local export files or local
export folders. Do not sign in to AI apps, scrape web sessions, request account
cookies, or infer private conversation history from another source.

Convert selected export records into reviewed Markdown pages in a local staging
folder, then import those pages with:

```bash
voltmind import /path/to/staged-conversations --no-embed --source-id <source-id>
```

Use `voltmind extract-conversation-facts --source-id <source-id> --dry-run` only
as a preview when the pages are already in VoltMind and the user wants fact
extraction. Apply writes only after review and citation checks.

### Processing

For each conversation:
1. **Assess significance** (1-5 scale):
   - 1 = Pure utility (how-tos, quick lookups) → skip or minimal page
   - 2 = Minor context → 1-paragraph note
   - 3 = Notable (reveals interests, building something) → full page
   - 4 = Important (deep personal processing, strategic thinking) → rich page
   - 5 = Defining (identity work, breakthrough insights) → full treatment
2. **Extract entities** — people, companies, concepts discussed
3. **Capture original thinking** — the user's exact phrasing is the signal.
   Never paraphrase.
4. **File by primary subject** — do not create a mixed conversation dump. For
   Microsoft Teams, preserve only the topic-split raw transcript under
   `sources/teams/`; summaries and extracted state go to their canonical homes.

### Quality rule

Only import conversations rated 3+. The brain is for signal, not noise.

## Phase 6: Existing Markdown / Obsidian Import

**The highest-leverage first import.** If the user already has a notes system, this
is hundreds or thousands of structured pages ready to go.

### Discovery

Use platform-appropriate local file discovery. Prefer asking the user for the
candidate notes/vault directory; if they want help finding it, scan likely local
folders read-only and ignore `.git`, `.obsidian`, `node_modules`, and generated
build directories. Do not run web, cloud-drive, or archive crawlers as part of
MVP cold start.

Before importing, confirm the target source:

```bash
voltmind sources current
voltmind sources list
```

### Import

```bash
# For markdown directories, including Obsidian vaults treated as markdown
voltmind import /path/to/dir --no-embed --workers 4 --source-id <source-id>

# Verify
voltmind stats
voltmind search "<topic from the imported data>"
```

### Post-import

- Preview link and timeline extraction before writing:
  `voltmind extract all --source db --source-id <source-id> --dry-run`
- Run extraction after review:
  `voltmind extract all --source db --source-id <source-id>`
- Start embeddings only after approval/provider readiness:
  `voltmind embed --stale`

> **Track progress** in one `state/indexes/teams-outlook-coldstart-<start>-to-<end>.md`
> manifest. The vault template `templates/cold-start-ingest-manifest.md` is the
> required scaffold. Its frontmatter holds the macro cold-start phase state;
> its ledger and container details hold the micro ingestion state. Do not write
> a second state file for the same run.

Set `next_phase` to the first missing approved phase id. Use `null` only when
there are no remaining approved phases to run. The manifest is updated after
every phase and every attempted Teams/Outlook window.

### Phase state ids

Use one numbering convention in manifest frontmatter:

| Phase id | Meaning |
|----------|---------|
| 0 | Microsoft connector scope and consent |
| 1 | Outlook Calendar |
| 2 | Outlook Email |
| 3 | Microsoft Teams |
| 4 | Cross-source reconciliation |
| 5 | Conversation exports |
| 6 | Existing Markdown / Obsidian import |

`phases_completed` and `phases_skipped` are arrays of these numeric ids.
`next_phase` is the next numeric id to run, or `null` when cold start is done.
Do not write string phase names into `next_phase`.


## Post-Bootstrap Checklist

After completing available phases:

1. **Verify brain health:**

   ```bash
   voltmind status
   voltmind health
   voltmind doctor --fast
   voltmind stats
   ```

2. **Test retrieval:**

   ```bash
   voltmind search "<person from Microsoft data>"
   voltmind query "who do I meet with most often?"
   voltmind query "what projects are active right now?"
   voltmind query "what commitments are open?"
   ```

3. **Sync after writes:**

   ```bash
   voltmind sync --no-pull --no-embed
   ```

4. **Refresh embeddings only after approval/provider readiness:**

   ```bash
   voltmind embed --stale
   ```

5. **Close the manifest:** set `next_phase: null`, summarize coverage, and
   ensure each Teams/Outlook ledger row is either complete, skipped,
   review-required, or explicitly blocked. Do not overwrite a raw-evidence or
   retry record merely to mark the overall phase complete.

6. **Tell the user what to do next:**

   > "Your brain has N pages across calendar, email, Teams, people, projects,
   > meetings, and conversations. From here:
   > - Ask 'what am I working on?' to test project memory
   > - Ask 'who do I meet with most often?' to test relationship memory
   > - Ask 'what commitments are open?' to test action extraction
   > - Say 'enrich [person/project]' to deepen any page"

## Anti-Patterns

- **Asking for raw Microsoft tokens.** Never ask the user to paste OAuth tokens,
  Graph tokens, cookies, or mailbox credentials. Use the connected Microsoft
  app tools only.
- **Bulk importing everything without filtering.** The brain is for signal, not
  noise. Filter automated mail, notifications, status chatter, and duplicate
  source records.
- **Treating Calendar, Email, and Teams as separate silos.** Cold start is only
  valuable when the same people, projects, meetings, and commitments reconcile
  across all three.
- **Importing without entity cross-linking.** Every import should detect
  entities and update existing pages. Isolated imports don't compound.
- **Not gating on user consent.** Every phase should be presented as a choice.
  The user may not want a mailbox, Teams channel, or calendar included.
- **Creating people pages for automated senders or bots.** System accounts,
  app bots, newsletters, ticketing tools, and notification senders are not
  people.
- **Writing uncited facts.** If it came from Calendar, Email, or Teams, cite the
  source and date.
- **Running embeddings before approval.** Provider-backed embeddings can send
  imported text outside the local database. Ask first.

## Resume Protocol

If the session is interrupted:

1. Find the active local cold-start manifest under `state/indexes/` and read it.
2. Skip any phase whose number is already in `phases_completed`; skip any phase
   listed in `phases_skipped`.
3. Resume from numeric `next_phase`, or compute the first missing phase id when
   `next_phase` is null or absent.
4. For Teams/Outlook, select the next eligible manifest work unit: due
   `rate_limited`, then captured semantic work, then the next pending container.
   Do not re-read `blocked_by_connector_pagination` history. Treat `reading`
   records older than 20 minutes as interrupted and rerun idempotently.
5. Re-check user consent before reading any new mailbox, calendar, chat, or
   channel scope.
6. Run `voltmind status`, `voltmind health`, and `voltmind stats` before
   continuing.

If a legacy state file contains `next_phase` as a string, map it before
continuing:

| Legacy string | Numeric id |
|---------------|------------|
| `connector_scope` | 0 |
| `outlook_calendar` | 1 |
| `outlook_email` | 2 |
| `microsoft_teams` | 3 |
| `cross_source_reconciliation` | 4 |
| `conversation_exports` | 5 |
| `markdown_import` | 6 |

The user should not have to repeat connector setup or re-import completed
source windows.

## Output Format

After each phase:

```text
PHASE N COMPLETE: [source name]
================================

Pages created: N
Pages updated: N
Entities linked: N
Timeline entries: N
Actions/commitments extracted: N
Time elapsed: N min

Sample pages:
- people/jane-smith.md (created — 3 emails, 5 meetings, 2 Teams threads)
- projects/acme-rollout.md (updated — 4 threads, 2 commitments)
- daily/calendar/2026/2026-06-11.md (updated — 6 events)

Skipped as low-signal:
- N automated emails
- N utility calendar events
- N Teams bot/status messages

Next: Phase N+1 — [description]. Ready to proceed?
```

## Tools Used


- `search` / `voltmind search` — check for existing pages before creating.
- `query` / `voltmind query` — hybrid search for entity and project
  deduplication after embeddings exist.
- `get_page` / `voltmind get` — read existing pages for merge decisions.
- `put_page` / `voltmind put` — create and update reviewed brain pages.
- `add_link` / `voltmind link` — cross-reference people, companies, projects,
  meetings, and conversation pages.
- `add_timeline_entry` / `voltmind timeline-add` — record dated events on
  entity and project timelines.
- `sync_brain` / `voltmind sync --no-pull --no-embed` — sync changes to the
  index after each phase.
- `voltmind import` — ingest reviewed local markdown/staged conversation pages.
- `voltmind extract all --source db --source-id <source-id>` — rebuild links
  and timeline entries for imported local pages after preview.
- `voltmind extract-conversation-facts --source-id <source-id> --dry-run` —
  preview fact extraction from imported conversation pages.
- `voltmind embed --stale` — refresh embeddings after user approval and
  provider readiness.
- `voltmind status`, `voltmind health`, `voltmind stats`, and
  `voltmind doctor --fast` — verify runtime health and import results.
