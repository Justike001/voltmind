---
name: ingest
description: Route content and external file references into VoltMind, including normalized Teams/meeting/email evidence and client-authored long-running project tracking. Use for ingestion, tracking-aware evidence submission, Teams/Outlook attachments, SharePoint/OneDrive links, mapped shared drives, or materializing a referenced file.
triggers:
  - "ingest this"
  - "save this to brain"
  - "process this meeting"
  - "configure shared drive"
  - "configure raidrive"
  - "map z drive"
  - "shared drive path mapping"
  - "sharepoint attachment"
  - "onedrive file"
  - "raidrive path"
  - "shared drive path"
  - "配置共享盘"
  - "配置 raidrive"
  - "映射 z 盘"
  - "submit tracked evidence"
  - "ingest project progress"
  - "提交项目进展证据"
tools:
  - search
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
  - sync_brain
  - search_file_refs
  - list_page_file_refs
  - attach_file_refs
  - file_ref_materialize
  - submit_ingestion_event
  - register_tracking_evidence
mutating: true
writes_pages: true
writes_to:
  - people/
  - orgs/
  - companies/
  - concepts/
  - meetings/
  - sources/
  - projects/
  - workstreams/
  - state/indexes/
  - state/actions/
  - state/decisions/
  - state/commitments/
  - state/risks/
---

# Ingest Skill

> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md) for the lookup chain (search → query → get_page → external).

Ingest meetings, articles, media, documents, and conversations into the brain.

> **Filing rule:** Read `skills/_brain-filing-rules.md` before creating any new page.

> **Taxonomy rule:** For every new page, route through `brain-taxonomist` and the
> active schema pack (`voltmind schema show --json`). In client-first thin-client
> mode, also read the local-vault taxonomy preflight in
> [client-vault-taxonomy.md](references/client-vault-taxonomy.md) before choosing
> or validating the slug. The active pack remains the machine-readable routing
> authority; vault resolver/schema/index/README files supply local policy and
> directory context and must not be silently ignored.

<!-- ingest-reference-router -->
## Reference Router

This file remains the mandatory core workflow. Before performing a matching
specialized operation, read every applicable reference completely. References
add mode-specific constraints; they do not replace, reorder, or relax the
evidence, citation, entity-linking, tracking, and completion requirements in
this file. Multiple rows may apply to one ingest.

| Ingest signal or operation | Required reference |
|---|---|
| Ambiguous or incomplete notable signal; clarification before semantic commit | [clarification-and-semantic-commit.md](references/clarification-and-semantic-commit.md) |
| Teams, Outlook Email, Outlook Calendar, Microsoft relay, or Microsoft file reference | [microsoft-connectors.md](references/microsoft-connectors.md) |
| Outlook Email acquisition, reply/forward history, rolling announcement, semantic timeline write, revision, deduplication, or chronological reconciliation | [outlook-email-timeline-reconciliation.md](references/outlook-email-timeline-reconciliation.md) |
| RaiDrive, SMB, UNC, mapped-drive configuration, normalization, lookup, or materialization | [mapped-shared-drive.md](references/mapped-shared-drive.md) |
| Any ingest pass: entity mentions or the user's original thinking | [entity-detection.md](references/entity-detection.md) |
| Article, video, podcast, PDF, image, meeting transcript, social post, or raw-source storage | [media-and-raw-source.md](references/media-and-raw-source.md) |
| Client-authored local-first semantic write, remote synchronization, receipt, or incremental Teams checkpoint | [client-write-through.md](references/client-write-through.md) |
| Teams cold start, history window, 99-result cap, saturation, 429, or cold-start manifest | [teams-cold-start.md](references/teams-cold-start.md) |
<!-- /ingest-reference-router -->

## Contract

- Every fact written to a brain page carries an inline `[Source: ...]` citation with date and provenance.
- Every entity mention creates a back-link from the entity's page to the page mentioning them (Iron Law).
- Raw sources are preserved for provenance via `voltmind files upload-raw` with
  automatic size routing. SharePoint/OneDrive and mapped shared-drive
  references are the exception: metadata is preserved in `external_file_refs`
  and projected onto the page; the binary is not copied until an explicit
  materialization request.
- State sections are rewritten with current best understanding, never appended to.
- Entity detection fires on every inbound message; notable entities get pages or updates.
- Structured events may carry `tracking_refs` and `evidence_type`; preserve
  these fields when forwarding events so runtime can reconcile existing
  project/workstream pages.
- Canonical source evidence MUST retain stable identity in Frontmatter before
  any tracking write: `event_id` (or `tracking_event_id`),
  `event_version` (or `tracking_event_version`), `evidence_type`, and
  `tracking_refs`. The company-server evidence sweep uses only these fields to
  find a client crash or network failure between `put_page` and registration;
  it does not infer identity from transcript text.
- Client-agent ingest may write `projects/`, `workstreams/`, and canonical
  action/decision/commitment/risk pages after Brain-First Lookup. Write raw
  source evidence first, preserve user prose via managed blocks, cite the
  evidence page, then call `register_tracking_evidence`. The server never
  repeats this semantic write on the ingest hot path.
- Client-authored ingest is **local-vault first**: write raw and derived
  Markdown locally, validate it, then synchronize the exact files with remote
  `put_page` and register receipts. A remote write is not a substitute for a
  durable local source page.
- Ambiguous but notable signals are durable work, not noise. Preserve the raw
  evidence, keep uncertain inference out of canonical truth, and route a stable
  candidate to `state/indexes/ingest-clarification-review` through
  `skills/clarification-review/SKILL.md`.

> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking.
> **Convention:** See `skills/conventions/page-template-contract.md` for the canonical draft-backed write format.
> **Convention:** See `skills/conventions/client-ingest-control-plane.md` for
> local-first synchronization, coverage, file references, candidate routing,
> and receipt rules.

Every mention of a person or company with a brain page MUST create a back-link
FROM that entity's page TO the page mentioning them. An unlinked mention is a
broken brain. See `skills/_brain-filing-rules.md` for format.

## Citation Requirements (MANDATORY)

Every fact written to a brain page must carry an inline `[Source: ...]` citation.

- **User's statements:** `[Source: User, {context}, YYYY-MM-DD]`
- **Meeting data:** `[Source: Meeting "{title}", YYYY-MM-DD]`
- **Email/message:** `[Source: email from {name} re: {subject}, YYYY-MM-DD]`
- **Web content:** `[Source: {publication}, {URL}, YYYY-MM-DD]`
- **Social media:** `[Source: X/@handle, YYYY-MM-DD](URL)` (include link)
- **Synthesis:** `[Source: compiled from {sources}]`

## Phases

> **Router note:** This skill is a router. For specialized ingestion, see: idea-ingest, media-ingest, meeting-ingestion.

1. **Parse the source.** Extract people, companies, dates, events, and any
   external file references from the input. Classify each statement as
   `observed`, `inferred`, or `confirmed`. Preserve observed evidence;
   canonical semantic pages may contain only confirmed assertions. For every
   action candidate, preserve a structured intermediate projection before any
   prose summary is generated:

   ```yaml
   action_slug: state/actions/example-action
   assignees:
     - slug: people/alice-example
       display_name: Alice Example
       source_text: Alice Example
   ```

   Resolve adjacent connector mentions from their structured mention nodes or
   known entity aliases. Never re-extract or guess assignees from the generated
   action summary.
2. **Route external file references.** Validate each
   `ExternalFileReferenceV1` and attach it to the source page. Microsoft files
   use tenant/drive/item identity. RaiDrive and mapped shared drives use a
   cross-user logical `root_key` plus normalized `relative_path`, or
   `root_key + file_id` when the storage system supplies a stable file ID.
   The thin client converts a user's `Z:\...` or username-specific UNC path to
   that logical locator before sending it; new events must omit `open_path`.
   Search and query can then find the file by name or logical path without
   copying it. Include `schema_version: 1` and the non-empty occurrence
   identity required by the control-plane convention; a malformed file reference
   is a retryable write error, not a reason to drop the reference. Use
   `file_ref_materialize` only after a user explicitly requests file analysis.
3. **Classify each new entity before writing:**
   - Check for an existing page by stable external identity before using a name
     match. For Teams data, prefer `conversation_id`, then `team_id + channel_id`,
     then aliases/display name.
   - Ask `brain-taxonomist` to resolve the page type and path from the active
     schema pack. Never hardcode a folder because the source is Teams or because
     a page resembles an existing page.
   - An internal Teams group chat may be written to `orgs/` when no formal org
     record is available, but it MUST be marked as a provisional communication
     container rather than inferred as a Department, Function, or formal Team.
     Use the stable Teams identifiers in frontmatter:

     ```yaml
     type: org
     org_kind: teams_group_chat
     classification_status: provisional
     source_system: teams
     conversation_id: <stable-id>
     team_id: <stable-id>
     channel_id: <stable-id>
     ```

     Omit identifiers that are not present. Do not create separate role pages;
     keep role fields on `people/` and `orgs/` pages.
4. **For each entity mentioned:**
   - Read the entity's page from voltmind to check if it exists
   - If exists: update compiled_truth (rewrite State section with new info, don't append)
   - If new: apply the notability gate from `skills/_brain-filing-rules.md`, then store the page in voltmind with the appropriate type and slug
5. **Long-running tracking.** Persist canonical raw evidence first. The source
   page must carry the stable event identity fields described above. Then run
   Brain-First Lookup over `projects/`, `workstreams/`, bindings, aliases,
   backlinks, and Timeline. A unique match is updated; an unbound event may
   create a project when goal/owner/scope/status/completion condition are clear,
   or a workstream when it is a durable responsibility domain with no fixed end
   date. Multiple candidates are appended immediately to
   `state/indexes/project-tracking-review`; this is non-blocking and must not
   be held only in the current session. Identity, fact, relationship, owner,
   time, privacy, or brain/source ambiguity instead goes to
   `state/indexes/ingest-clarification-review`. If both ambiguity classes apply,
   cross-reference the records rather than duplicating the question.
   One evidence event may update multiple targets. Update Timeline, managed
   current state, and canonical state objects with evidence links and
   `[Source: ...]`; then call `register_tracking_evidence` with the actual
   `client_outcome`, `affected_pages`, and `action_assignments` (including
   `no_signal`). For every affected action, the deterministic registration gate
   checks that every structured assignee appears in `owner` or
   `related_people`, as an explicit body wikilink, and on the assignee's person
   page as a backlink to the action. Any missing surface forces
   `semantic_status: review_required` and `client_outcome: review_needed`; the
   ingest unit cannot be marked complete until the same event revision passes.
6. **Append to entity timelines.** Add timeline entries to all relevant pages,
   including directly-bound projects/workstreams and canonical state objects.
   Do not use `submit_ingestion_event` for this client-authored path; that
   operation remains a server raw-ingest compatibility route.
7. **Create cross-reference links.** Link entities in voltmind for every entity pair mentioned together, using the appropriate relationship type.
8. **Back-link all entities.** Update EVERY mentioned entity's page with a back-link to this page (Iron Law).
9. **Timeline merge.** The same event appears on ALL mentioned entities' timelines. If Alice met Bob at Acme Corp, the event goes on Alice's page, Bob's page, and Acme Corp's page.
10. **Schedule executable actions.** After all canonical local
    `state/actions/*.md` pages from this ingest are durable, invoke
    `skills/schedule-actions/SKILL.md` in interview mode. Hand off the exact
    local file paths and action slugs; do not read a database or remote action
    index first. Ensure each action retains its raw `source_refs` even when the
    semantic summary appears complete. That skill re-reads the locally preserved
    Teams/Outlook evidence, enriches the action with omitted observed details
    and citations, then asks about only the remaining gaps one action per turn.
    It persists the user-confirmed execution contract and exact time and
    registers the ChatGPT desktop scheduled task. Do not schedule directly from
    the ingest summary and do not treat extraction as execution consent.

<!-- ingest-reference:clarification-and-semantic-commit -->
> Read [clarification-and-semantic-commit.md](references/clarification-and-semantic-commit.md) whenever ingest contains ambiguous or incomplete notable signals.
<!-- /ingest-reference:clarification-and-semantic-commit -->
<!-- ingest-reference:microsoft-connectors -->
> Read [microsoft-connectors.md](references/microsoft-connectors.md) for Teams, Outlook Email, Outlook Calendar, Microsoft relay, or Microsoft file-reference ingest.
<!-- /ingest-reference:microsoft-connectors -->
<!-- ingest-reference:mapped-shared-drive -->
> Read [mapped-shared-drive.md](references/mapped-shared-drive.md) for RaiDrive, SMB, UNC, mapped-drive configuration, normalization, lookup, or materialization.
<!-- /ingest-reference:mapped-shared-drive -->
<!-- ingest-reference:entity-detection -->
> Read [entity-detection.md](references/entity-detection.md) for the always-on entity and original-thinking detection pass during ingest.
<!-- /ingest-reference:entity-detection -->
<!-- ingest-reference:media-and-raw-source -->
> Read [media-and-raw-source.md](references/media-and-raw-source.md) for articles, video, podcasts, PDFs, images, meetings, social media, and raw-source storage.
<!-- /ingest-reference:media-and-raw-source -->
## Test Before Bulk

When processing multiple items (batch video ingestion, bulk meeting processing, etc.):

1. **Test on 3-5 items first.** Run in test mode if available.
2. **Read the actual output.** Is the quality good? Are titles compelling (not
   "This video discusses...")? Are entities extracted and back-linked? Is the
   format clean?
3. **Fix what's wrong** in the approach/skill, not via one-off patches.
4. **Only then: bulk execute** with throttling, commits every 5-10 items.

The marginal cost of testing 3 items first is near zero. The cost of cleaning
up 100 bad pages is enormous.

## Quality Rules

- Executive summary in compiled_truth must be updated, not just timeline appended
- State section is REWRITTEN, not appended to. Current best understanding only.
- Timeline entries are reverse-chronological (newest first)
- Every person/company mentioned gets a page if notable (see filing rules)
- Link types: knows, works_at, invested_in, founded, met_at, discussed
- Source attribution: every timeline entry includes [Source: ...] citation
- Back-links: every entity mention creates a back-link (Iron Law)
- Filing: file by primary subject, not format or source (see filing rules)

## Anti-Patterns

- **Appending to State sections.** State is rewritten with the current best understanding on every update. Append-only State sections grow stale and contradictory.
- **Ingesting without back-links.** An unlinked mention is a broken brain. Every entity mentioned must have a back-link from their page to the page mentioning them.
- **Skipping raw source preservation.** Every ingested item must have its raw source preserved. A brain page without provenance is unverifiable.
- **Bulk processing without sample test.** Test on 3-5 items first. Fix quality issues in the approach, not via one-off patches.
- **Paraphrasing the user's original thinking.** The user's exact language IS the insight. Capture verbatim phrasing for ideas, theses, and frameworks.
- **Dropping or prematurely committing ambiguity.** Preserve notable unresolved
  signals in the clarification queue; do not ignore them and do not write
  inferred meaning into canonical truth.
- **Writing project tracking state.** The client agent is the primary semantic
  writer: evidence first, then direct `put_page` updates/creates for bound
  projects, workstreams, and canonical state objects, followed by
  `register_tracking_evidence`. Server Dream only audits and repairs anomalies.

## Output Format

<!-- ingest-reference:client-write-through -->
> Read [client-write-through.md](references/client-write-through.md) for client-authored local-first writes, remote synchronization, receipts, and incremental Teams checkpoints.
<!-- /ingest-reference:client-write-through -->
<!-- ingest-reference:teams-cold-start -->
> Read [teams-cold-start.md](references/teams-cold-start.md) for Teams history windows, connector caps, saturation, 429 handling, and cold-start manifests.
<!-- /ingest-reference:teams-cold-start -->

```
INGESTED: [title]
==================

Page: [slug]
Type: [person / company / meeting / media / concept]
Source: [source description]

Entities detected: N
- [entity] -> [created / updated] ([slug])

Back-links created: N
Timeline entries: N
Raw source: [preserved at path / uploaded to cloud]
```

## Tools Used

- Read a page from voltmind (get_page)
- Store/update a page in voltmind (put_page)
- Add a timeline entry in voltmind (add_timeline_entry)
- Link entities in voltmind (add_link)
- List tags for a page (get_tags)
- Tag a page in voltmind (add_tag)
- Store raw data in voltmind (put_raw_data)
- Check backlinks in voltmind (get_backlinks)
