---
name: clarification-review
version: 1.0.0
description: |
  Preserve, reconcile, and resolve ambiguous ingest signals before canonical
  semantic write-through. Use when Teams, Outlook, meetings, or other partial
  evidence leaves entity identity, semantic routing, ownership, timing,
  relationships, privacy, or brain/source placement uncertain; also use when
  reviewing pending questions from state/indexes/ingest-clarification-review.
triggers:
  - "review ingest questions"
  - "clarify missing context"
  - "resolve ambiguous signals"
  - "pending clarification review"
  - "澄清待确认信息"
  - "处理待确认问题"
tools:
  - search
  - query
  - get_page
  - put_page
  - add_timeline_entry
  - register_tracking_evidence
mutating: true
writes_pages: true
writes_to:
  - state/indexes/
  - people/
  - orgs/
  - companies/
  - concepts/
  - meetings/
  - projects/
  - workstreams/
  - state/actions/
  - state/decisions/
  - state/commitments/
  - state/risks/
---

# Clarification Review

Resolve incomplete evidence without discarding a signal or promoting an
inference into canonical truth.

> **Convention:** Read `skills/conventions/brain-first.md` before reconciling a
> candidate and `skills/conventions/client-ingest-control-plane.md` before any
> client-authored write-through.
>
> **Choice gate:** Use `skills/ask-user/SKILL.md` for every user-facing choice.
> It presents one question per turn and stops after asking; this skill owns the
> durable queue and resumes the workflow on the user's next turn.

## Contract

- Persist raw evidence before clarification. Missing context never blocks raw
  capture or unrelated work in the same batch.
- Store every notable unresolved inference in
  `state/indexes/ingest-clarification-review`; never leave it only in session
  context and never write it into a canonical page as fact.
- Default to deferred clarification after the available ingest batch has been
  captured and reconciled. Ask immediately only when the affected semantic
  write is high-impact and cannot safely be staged.
- Ask one question per turn with 2-4 self-explanatory choices and an escape
  hatch. A user may answer with free text when none of the proposed choices fit.
- After an answer, preserve the raw evidence and the user clarification as
  separate provenance, then perform client-first local Markdown write-through.
- Keep queue state idempotent and auditable: repeated events or retries must not
  create duplicate questions or repeat already resolved questions.

## Epistemic states

Classify each extracted statement before semantic routing:

- `observed` — present in the captured source; safe to preserve as evidence.
- `inferred` — plausible but not established; queue for reconciliation or
  clarification and keep it out of canonical truth.
- `confirmed` — established by sufficient evidence or direct user
  clarification; eligible for semantic write-through with citations.

Confidence and impact are separate. Low-confidence, low-impact material can
wait; a high-confidence cross-brain or privacy-sensitive write may still need a
gate.

## Candidate record

Append candidates to `state/indexes/ingest-clarification-review` as operational
records. Use a stable `question_id` derived from source identity, normalized
evidence span, and `question_type`; do not derive identity from a summary.

```yaml
question_id: clarify:teams:<container-id>:<message-id>:<hash>
status: pending_review # pending_review | asked | answered | resolved | skipped | superseded
question_type: entity_identity # entity_identity | semantic_route | missing_fact | relationship | time | owner | privacy | brain_route
impact: deferred # deferred | blocks_semantic_write | blocks_cross_boundary_write
source_refs:
  - sources/teams/<source-page>
event_id: <stable-event-id>
event_version: <stable-event-version-or-null>
observed_excerpt: <verbatim source text>
missing_criterion: <what must be known before canonical write>
proposed_question: <one concise question>
candidate_answers:
  - <self-explanatory answer>
confidence: 0.42
proposed_targets: []
answer: null
answered_at: null
resolution: null
affected_pages: []
updated_at: <ISO-8601>
```

When a newer event version or later evidence answers a question, mark the old
record `resolved` or `superseded`; do not append a second active candidate.
The queue is operational metadata, not a semantic citation source and not an
`affected_pages` target for `register_tracking_evidence`.

## Phases

### 1. Capture and enqueue

1. Persist the exact raw Teams, Outlook, meeting, or other evidence locally.
2. Write confirmed, independent facts normally.
3. For every notable inference that lacks a required criterion, append or
   update one candidate record and set the ingest unit's
   `semantic_status: review_required`.
4. Keep project/workstream candidate routing in
   `state/indexes/project-tracking-review`; use the generic clarification queue
   for identity, fact, relationship, time, owner, privacy, and brain/source
   ambiguity. Cross-link the records when both apply.

### 2. Choose deferred or immediate review

Default to deferred review when later records may supply context, the ambiguity
affects only one low-impact assertion, or ingest is unattended/batch-oriented.

Use an immediate choice gate only when proceeding would:

- merge or overwrite the wrong entity;
- write across a brain/source ownership or privacy boundary;
- create an actionable decision, commitment, action owner, or deadline from an
  unconfirmed inference; or
- materially corrupt an existing canonical page.

Even then, block only the affected semantic write. Continue raw capture and
unrelated routing.

### 3. Reconcile before asking

After the available batch is durable:

1. Run Brain-First Lookup for the candidate's entities and proposed targets.
2. Compare later messages, other source pages, event versions, aliases,
   backlinks, and timelines.
3. Deduplicate questions that share the same missing criterion; prefer one
   question that resolves several downstream candidates.
4. Resolve or supersede candidates when evidence is sufficient, recording the
   evidence refs used. Do not ask the user questions that the captured corpus
   can answer.
5. Rank the remainder by write impact, number of candidates unblocked, and age.

### 4. Open a clarification session

At the end of an interactive ingest, use `ask-user` for a single session gate:

1. **Review now** — ask the highest-value unresolved question.
2. **Review later** — leave candidates pending and report the durable queue.
3. **Skip this batch** — mark the selected batch skipped without inventing
   semantic truth.

Stop the turn after presenting this gate. Do not ask all pending questions in
one message.

### 5. Ask and resume one question at a time

For the selected candidate, present 2-3 likely answers plus **Skip**. Include
only the minimum source excerpt needed to understand the choice. After the user
responds:

1. Record the answer verbatim with `[Source: User clarification, YYYY-MM-DD]`.
2. Mark the candidate `answered` before attempting derived writes.
3. Re-evaluate linked candidates; one answer may resolve several.
4. Ask the next question only in a later turn and only after the current answer
   has been durably handled.

### 6. Perform semantic write-through

Do not rewrite raw evidence to make oral context appear in the original source.
Create a clarification addendum or preserve the answer in the review record,
then update canonical pages with both provenances:

```markdown
该名称指内部迁移项目，计划于下周切换。
[Source: Teams message "...", YYYY-MM-DD]
[Source: User clarification, YYYY-MM-DD]
```

For client-authored ingest, write through in this order:

1. Persist the clarification and updated canonical Markdown locally.
2. Run `voltmind put <slug> < page.md` for each canonical page. The local writer
   validates and atomically writes before forwarding the exact bytes to remote
   `put_page`; do not call Host MCP `put_page` directly as the first write.
3. Synchronize source evidence before derived pages.
4. For tracking evidence, call `register_tracking_evidence` only after the
   remote source write succeeds and pass only pages actually changed.
5. Mark candidates `resolved` with `affected_pages` and resolution evidence.
   On remote failure, keep `local_written_remote_pending` and retry from the
   local files without asking the question again.

## Output Format

Before user review, report only durable state:

```text
Clarification review: 7 candidates captured, 3 self-resolved, 4 pending.
Queue: state/indexes/ingest-clarification-review
Next: review_now | review_later | skip_batch
```

After a resolved answer:

```text
Clarification resolved: <question_id>
Candidates resolved: N
Pages written through: <slugs>
Remaining questions: N
```

## Anti-Patterns

- Dropping an ambiguous but notable signal because it cannot yet be classified.
- Writing `inferred` content into compiled truth with words such as "probably".
- Interrupting every Teams or meeting fragment with an immediate question.
- Asking multiple questions in one `ask-user` gate or continuing work after the
  gate is presented.
- Rewriting raw evidence to include facts learned later from the user.
- Treating the clarification queue as an affected semantic page or citation.
- Calling remote `put_page` before the client-local write-ahead step.

## Tools Used

- `search` / `query` — reconcile a candidate against existing brain context.
- `get_page` — load source, entity, target, and queue pages.
- `put_page` — remote synchronization after the client-local write succeeds.
- `add_timeline_entry` — add confirmed dated facts only.
- `register_tracking_evidence` — register actual tracking writes after source
  synchronization; never register the clarification index as affected state.
