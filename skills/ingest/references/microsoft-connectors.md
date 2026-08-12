### Teams group-chat identity and later reconciliation

During MVP, a durable Teams group chat is an `orgs/` page with
`org_kind: teams_group_chat` and `classification_status: provisional` when the
connector cannot prove a formal organizational unit. This is an ingestion
container, not a claim about the company's org chart.

When deeper Graph permissions become available, reconcile in place by stable
Teams identifiers. Update `org_kind`, ownership, membership, and scope on the
same page; do not create a second org page merely because the chat is later
resolved to a formal Team, Department, Function, Committee, or Working Group.

### Microsoft reference ingest

The connector owns Microsoft OAuth and delta cursors. VoltMind accepts only the
OAuth-bound relay's normalized event and never accepts `source_id` from the
payload. `POST /ingest/events` is idempotent by source, platform, event ID, and
event version; replaying an older version cannot overwrite a newer page.

The managed `voltmind:file-refs` block is searchable content. Human-authored
content and non-relay references must remain untouched when a relay refreshes
the block. `search_file_refs` is preferred for exact path, item ID, service, or
MIME queries; normal `search`/`query` results also carry hydrated `file_refs`.

### Outlook Email And Calendar Signal Policy

When an ingest event comes from Outlook Email or Outlook Calendar, apply the
same signal/noise policy used by cold start. Do not treat every connector event
as a durable brain item. Filter low-signal records before creating pages, while
still preserving stable event identity for idempotency and later reconciliation.

#### Outlook Email

Classify each message or thread as one of:

- `email_thread` — a human conversation with durable context;
- `decision` — a decision, approval, or strategy change;
- `commitment` — an owner, obligation, or deadline;
- `project_update` — meaningful project, customer, partner, vendor, or candidate
  progress;
- `relationship_signal` — a durable change in role, relationship, or
  communication pattern;
- `automated_notification` — system, marketing, or utility mail;
- `duplicate_or_represented` — content already represented by Calendar, Teams,
  or another event with the same stable identity.

**Auto-skip unless the user explicitly requests it:**

- `noreply@`, `no-reply@`, `notifications@`, `support@`, and
  `mailer-daemon@` senders;
- newsletters, marketing mail, vendor drip campaigns, and unsubscribe-heavy
  senders;
- GitHub, Jira, Linear, Instagram, and other system notifications;
- raw calendar invitations already represented by a Calendar event;
- Teams reminders already represented by Teams data;
- routine announcements such as new-hire, work-anniversary, birthday,
  promotion, employee-spotlight, and similar status mail.

**Always import or review:**

- direct mail from people already present in the brain;
- mail sent by the user containing decisions, strategy, original thinking, or
  commitments;
- flagged, starred, or important threads;
- threads naming projects, customers, partners, candidates, vendors, or
  deadlines;
- threads with attachments or SharePoint/OneDrive/mapped-drive references.

For selected threads, extract the thread summary, entities, commitments and
actions, relationship context, project changes, and only notable timeline
entries. Cite every durable fact as `[Source: email from {name} re: {subject},
YYYY-MM-DD]`.

#### Outlook Calendar

Classify each event as one of:

- `meeting` — a meeting with attendees and durable context;
- `recurring_one_on_one` — a recurring 1:1 whose relationship or cadence
  matters;
- `project_meeting` — a board, customer, partner, hiring, planning, or
  incident meeting;
- `decision_or_deadline` — an event whose subject or body reveals a decision,
  deadline, or project milestone;
- `utility_event` — a reminder, focus block, lunch, travel buffer, holiday, or
  other scheduling utility;
- `duplicate_or_represented` — an event already captured as a meeting or from
  another source.

**Auto-skip unless the user explicitly requests it:**

- holidays, reminders, focus blocks, lunch, travel buffers, and private
  personal events without approval;
- events with no attendees and no useful context;
- recurring utility blocks that do not reveal relationships or projects;
- duplicate events or raw invites already represented elsewhere.

**Always consider for import or review:**

- events with external attendees;
- meetings with three or more attendees;
- recurring 1:1s;
- board, customer, partner, hiring, planning, and incident meetings;
- subjects that reveal a project, decision, deadline, or relationship.

For selected events, extract the subject, time, organizer, attendees, location,
online meeting link, body preview when available, entities, project context,
and notable timeline entries. Cite durable facts as
`[Source: Outlook Calendar, {event title}, YYYY-MM-DD]`.

#### Shared ingest behavior

1. Apply the source-specific classification before writing a page.
2. Preserve `event_id`, `event_version`, `evidence_type`, and `tracking_refs`
   when supplied by a connector relay.
3. Deduplicate cross-source representations before creating a second page or
   timeline entry.
4. Route selected signal through the normal Brain-First Lookup, entity
   classification, project tracking, citation, and back-linking phases.
5. Keep validated Outlook attachments and file links as metadata references;
   materialize or analyze the file only after an explicit user request.

