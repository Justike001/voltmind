---
name: meeting-ingestion
version: 1.0.0
description: |
  Ingest meeting transcripts into brain pages with attendee enrichment, entity
  propagation, and timeline merge. A meeting is NOT fully ingested until the
  enrich skill has processed every entity.
triggers:
  - "meeting transcript"
  - "process this meeting"
  - "meeting notes"
  - meeting transcript received
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
mutating: true
writes_pages: true
writes_to:
  - meetings/
  - people/
  - companies/
---

# Meeting Ingestion Skill

> **Filing rule:** Read `skills/_brain-filing-rules.md` before creating any new page.
> **Template rule:** Meeting pages must use the current Personal Brain meeting
> scaffold from `brain/templates/meetings.md` or
> `docs/drafts/personal-brain-scaffold/templates/meetings.md`. Keep the canonical
> section headings stable:
> `Attendees`, `Key Decisions`, `Action Items`, `Connections`,
> `Candidate Contributions`, and `Transcript`.

## Contract

This skill guarantees:
- Meeting page created with attendees, key decisions, action items, connections,
  candidate contributions, and transcript/source section
- EVERY attendee gets a people page (created or updated)
- EVERY company discussed gets entity propagation
- Timeline entries on ALL mentioned entities (timeline merge)
- Meeting is NOT fully ingested until enrich runs for every entity
- Back-links created bidirectionally

> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking.

Every attendee and company mentioned MUST get a back-link from their page to
the meeting page. An unlinked mention is a broken brain.

## Source Modes

### Calendar-seeded meeting

Use this mode when the only evidence is Outlook Calendar metadata: subject,
time, organizer, attendees, location, response state, and body preview.

- It may create a meeting page when the event is notable.
- It must clearly say that no transcript or meeting notes were available.
- It must not invent decisions, action items, risks, or project links.
- It should create or update attendee people pages only with facts returned by
  the connector.
- It should add attendee timeline entries and graph links when attendees are
  durable.

Calendar-seeded pages are useful index pages, but they are not "fully ingested"
meetings until transcript, notes, or follow-up evidence is added.

### Transcript or notes meeting

Use this mode when meeting notes, a transcript, or a meaningful summary is
available. This is the full meeting-ingestion path.

## Phases

### Phase 1: Parse the source

Extract from the available source. For transcript/notes, extract:
- Attendees (names, roles if available)
- Date, time, duration
- Key topics discussed
- Decisions made
- Action items with owners
- Companies and projects mentioned

For calendar metadata only, extract only what the connector actually returned:
- subject
- start/end time and timezone
- organizer
- attendees and response states
- location / Teams meeting marker
- body preview or invite metadata

### Phase 2: Create meeting page

Use the canonical meeting template from `brain/templates/meetings.md`. If that
file is unavailable in the active brain, fall back to
`docs/drafts/personal-brain-scaffold/templates/meetings.md`.

Do not duplicate the template inside this skill. The template file is the source
of truth for frontmatter keys, section headings, and Chinese body guidance.

For calendar-seeded meetings, keep the canonical headings but write "no
confirmed decision/action yet" with a source citation instead of leaving
sections blank.

### Phase 3: Attendee enrichment (MANDATORY)

For EACH attendee:
1. `voltmind search "{name}"` — does a people page exist?
2. If NO → create via enrich skill (this is mandatory, not optional)
3. If YES → update compiled truth with meeting context
4. Add timeline entry on the person's page:
   `voltmind timeline-add <person-slug> <date> "Attended <meeting-title>"`

**Note (v0.10.1):** Once the meeting page is written via `voltmind put`, the
auto-link post-hook automatically creates `attended` links from the meeting
to each attendee whose page is referenced as `[Name](people/slug)`. You don't
need to call `voltmind link` for attendees. You DO still need `voltmind timeline-add`
for dated events (auto-link only handles links, not timeline entries).

### Phase 4: Entity propagation (MANDATORY)

For each company, project, or concept discussed:
1. Check brain for existing page
2. Create/update as needed
3. Add timeline entry referencing the meeting
4. Back-link from entity page to meeting page

### Phase 5: Timeline merge

The same event appears on ALL mentioned entities' timelines. If Alice met Bob at
Acme Corp, the event goes on Alice's page, Bob's page, AND Acme Corp's page.

### Phase 6: Sync

`voltmind sync --no-pull --no-embed` to update the index.

## Output Format

Meeting page created. Report: "Meeting ingested: {N} attendees enriched, {N} entities
updated, {N} action items captured."

## Anti-Patterns

- Creating the meeting page without enriching attendees
- Skipping entity propagation ("I'll do that later")
- Not merging timelines across all mentioned entities
- Creating attendee stubs without meaningful content
- Filing meeting pages without cross-linking to all participants
