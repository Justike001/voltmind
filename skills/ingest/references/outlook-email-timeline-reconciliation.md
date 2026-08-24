### Outlook Email acquisition and timeline reconciliation

Use this reference only for Outlook Email. Keep the canonical page format,
client-first write order, citations, backlinks, and clarification gates from the
main ingest skill unchanged.

#### Connector capability boundary

The connector may expose a message `id`, body/body preview, participants,
subject, `receivedDateTime`, web link, folder filtering, and pagination. Do not
assume it also exposes `conversationId`, `internetMessageId`, `changeKey`,
`lastModifiedDateTime`, `sentDateTime`, `uniqueBody`, RFC reply headers, delta
cursors, or immutable Graph IDs unless those fields are present in the actual
tool result or contract.

Preserve the connector-provided message ID as `event_id`, but do not call it
stable unless the connector/provider guarantees stability. In Microsoft Graph,
the default message ID can change when a message is moved; an immutable ID is
stable across supported moves only when that ID mode is explicitly requested.
Never invent `event_version`. Use a connector-provided version when available;
otherwise retain content hashes and the observation time without pretending
they are a provider revision.

The Teams 99-result saturation rule does not apply to Outlook Email. Use the
Outlook connector's own pagination/continuation result and record incomplete
coverage honestly.

#### Message, conversation, and semantic event are different

- A reply or forward is normally a new message, not a revision of the original
  message.
- A conversation/thread ID groups related messages; it is not a message
  idempotency key.
- One message can contain several semantic facts, and several messages can
  repeat or refine one semantic fact. Do not enforce “one email = one timeline
  entry.”
- A moved or re-read message is not a new semantic event merely because the
  connector returns another observation or a different location-dependent ID.
  When identity cannot be reconciled confidently, preserve raw evidence and
  route the candidate to review instead of appending another semantic entry.

#### Current body versus quoted history

Prefer a connector-provided `uniqueBody` when available. When only the complete
body is available, distinguish the sender's current contribution from quoted
reply/forward history before semantic projection.

- Treat recognizable quoted blocks, forwarded-message headers, and repeated
  earlier messages as historical evidence, not as content newly asserted on
  the latest received date.
- If the boundary is uncertain, preserve the complete raw email but project
  only facts supported by the confidently current portion. Do not bulk-add the
  quoted history to a person's timeline.
- A body preview is discovery context, not complete evidence when the omitted
  text could change meaning.
- Forwarder commentary and the forwarded source are separate evidence spans;
  do not attribute the forwarded author's statement to the forwarder.

#### Rolling announcement threads

Some senders publish each update by replying to the previous announcement, so
the newest message contains the current update followed by all earlier updates.
Treat this as a rolling snapshot:

1. Preserve the latest complete message as raw evidence.
2. Compare its confidently current portion and historical sections with the
   semantic state already present in the target page.
3. Rewrite the page's current `State` when the latest update changes the current
   understanding.
4. Add timeline entries only for material changes not already represented.
5. If quoted history recovers a previously missed event, use that event's own
   date when available; do not assign the newest message's date.

Subject similarity alone is insufficient to merge messages into one rolling
series. Use available conversation context, participants, repeated-body
structure, dates, and citations. If that evidence is insufficient, keep the
messages separate at the raw-evidence layer and defer the semantic merge.

#### Client-first timeline write

Before updating a person, company, project, or other canonical page:

1. Persist the raw email evidence locally first with the connector-provided
   `event_id`, `event_version` only when available, `evidence_type: email`, and
   the best original timestamp. For received mail use `receivedDateTime`; for
   user-sent mail use `sentDateTime` only when supplied. Fall back to the
   observation/relay time only when no original timestamp exists, and record
   that limitation in the evidence rather than the semantic timeline.
2. Read the existing target page and its cited evidence. Decide whether the
   email introduces a new material fact, revises current state, supplies better
   confirmation, or merely repeats represented content.
3. Keep Outlook reconciliation fields out of canonical timeline lines. Preserve
   the existing Host format:

   ```markdown
   - **2026-08-24** | 客户确认了续约范围。[Source: email from alice-example re: Renewal, 2026-08-24]
   ```

4. Keep the complete `## Timeline` newest date first; order within one date is
   not significant. The local writer rejects an out-of-order list and an exact
   duplicate `{date, summary, detail}` before touching the vault. It does not
   perform fuzzy or Outlook-aware deduplication.
5. Run the normal local `voltmind put` write-through. A remote retry never
   authorizes a new local semantic entry.

Do not deduplicate distinct messages only because subjects, snippets, or LLM
summaries look alike. Conversely, do not repeat a semantic fact merely because
it appears again in quoted history or a later rolling snapshot. When a prior
projection cannot be identified from normal source citations and existing raw
evidence, route it to clarification/review instead of guessing.
