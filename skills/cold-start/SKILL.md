---
name: cold-start
version: 2.0.0
description: |
  Day-one data bootstrapping for a new VoltMind brain. Sequences the highest-
  leverage Microsoft sources to go from empty brain to useful brain in one
  session: Outlook Calendar, Outlook Email, and Microsoft Teams. Use when a
  user has just finished VoltMind setup and asks "now what?"
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
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
  - meetings/
  - daily/
  - conversations/
  - sources/
  - projects/
  - concepts/
---

# Cold Start — Microsoft Day-One Brain Bootstrapping

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
- The VoltMind MVP cold start uses only three live source families:
  Outlook Calendar, Outlook Email, and Microsoft Teams.
- Each phase is independently valuable — the user can stop after any phase and
  still have a useful brain.
- Progress is tracked in `VOLTMIND_HOME/cold-start-state.json` so interrupted
  sessions can resume.
- Entity detection and cross-linking run on every import, not as a separate
  pass.
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

Data sources ranked by **information density x ease of import**:

| Priority | Source | Why | Time | Pages Created |
|----------|--------|-----|------|---------------|
| 1 | Outlook Calendar (last 90 days) | Fastest map of people, meetings, projects, recurring work | 10-15 min | 30-90 daily/meeting/entity updates |
| 2 | Outlook Email (smart sample) | Relationship context, active threads, commitments, org chart signals | 20 min | 30-150 thread/entity/project updates |
| 3 | Microsoft Teams (recent chats/channels) | Decisions, coordination, informal context, open loops | 20 min | 20-100 conversation/project/entity updates |

Future non-Microsoft sources, generic web research, file/archive crawlers, and
autonomous ingestion are outside the MVP cold-start route. Add them later only
when their runtime and privacy boundaries are explicitly enabled.

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
5. **Emails with attachments only when the user approves attachment context** —
   attachment ingestion itself is outside the MVP unless text is already
   available through the connector.

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
- GitHub/Jira/Linear/system notifications unless the user explicitly asks
- raw calendar invites already represented in Calendar phase
- receipts, shipping notices, security alerts, password resets

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
  when they carry meaning, and linked meeting context when available.

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
2. **Extract decisions** — decisions are first-class facts.
3. **Extract actions** — owner, action, deadline, source message.
4. **Extract entities** — people, companies, projects, concepts.
5. **Update pages** — people/project/company pages get cited deltas.
6. **Create conversation pages** only when the thread itself is the durable
   artifact.
7. **Back-link entities** — every mentioned entity with a page links back to
   the Teams-derived page or update.

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

5. **Track state:**

   ```json
   // VOLTMIND_HOME/cold-start-state.json
   {
     "started": "2026-06-11T10:00:00+08:00",
     "sources_completed": ["outlook_calendar", "outlook_email", "teams"],
     "sources_skipped": [],
     "calendar_window_days": 90,
     "email_strategy": "sent_flagged_active_threads",
     "teams_window_days": 30,
     "total_pages_created": 0,
     "total_pages_updated": 0,
     "total_entities_linked": 0,
     "next_phase": "cross_source_reconciliation"
   }
   ```

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

1. Read `VOLTMIND_HOME/cold-start-state.json`.
2. Skip completed sources and phases.
3. Resume from `next_phase`.
4. Re-check user consent before reading any new mailbox, calendar, chat, or
   channel scope.
5. Run `voltmind status`, `voltmind health`, and `voltmind stats` before
   continuing.

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

- Outlook Calendar connector — list events, attendees, organizers, recurrence,
  meeting metadata, and calendar windows approved by the user.
- Outlook Email connector — search/list sampled messages and threads, inspect
  sender/recipient/time/preview/body snippets, and extract actions from
  approved mailbox scopes.
- Microsoft Teams connector — inspect approved recent chats/channels, summarize
  threads, and extract decisions, actions, people, projects, and blockers.
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
