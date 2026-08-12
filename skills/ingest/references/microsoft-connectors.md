# Microsoft Connector Ingest

Read this reference for Teams, Outlook Email, Outlook Calendar, or Microsoft
relay events.

## Stable identity and relay boundary

The OAuth-bound relay owns Microsoft authentication and delta cursors. Preserve
provider event identity and version. Never accept a caller-supplied source ID in
an untrusted payload. Deduplicate cross-source representations before creating
a second semantic page or timeline entry.

For Teams containers, prefer stable chat/conversation/team/channel IDs over
names. Adjacent mention nodes must remain separately identifiable even when
their rendered text is concatenated.

## Teams group chats

A durable group chat may be stored as a provisional communication-container
`org` with `org_kind: teams_group_chat`. Reconcile it in place when later Graph
permissions establish its formal type; do not create a duplicate org page.

## Outlook Email signal policy

Classify selected mail as `email_thread`, `decision`, `commitment`,
`project_update`, `relationship_signal`, `automated_notification`, or
`duplicate_or_represented`.

Auto-skip routine no-reply/system notifications, newsletters, marketing,
calendar invitations already represented elsewhere, and routine announcements
unless explicitly requested. Always consider direct mail from known people,
user-sent decisions/strategy/commitments, flagged mail, project/customer/vendor
threads, deadlines, attachments, and file references.

For selected threads extract summary, entities, commitments/actions,
relationship context, project changes, and only notable timeline entries. Cite
as `[Source: email from {name} re: {subject}, YYYY-MM-DD]`.

## Outlook Calendar signal policy

Classify selected events as `meeting`, `recurring_one_on_one`,
`project_meeting`, `decision_or_deadline`, `utility_event`, or
`duplicate_or_represented`.

Skip holidays, reminders, focus blocks, lunch/travel buffers, private personal
events without approval, attendee-free utility events, and duplicates unless
explicitly requested. Always consider external attendees, 3+ attendees,
recurring 1:1s, board/customer/partner/hiring/planning/incident meetings, and
subjects revealing decisions or deadlines.

For selected events preserve subject, time, organizer, attendees, location,
meeting link, useful body preview, entities, and project context. Cite as
`[Source: Outlook Calendar, {event title}, YYYY-MM-DD]`.
