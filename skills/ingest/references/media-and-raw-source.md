## Media Workflows

Content the user encounters should be captured in the brain. File by PRIMARY
SUBJECT, not by format (see `skills/_brain-filing-rules.md`).

For Teams, Outlook, and meeting raw evidence, apply the source namespace rule
in [microsoft-connectors.md](microsoft-connectors.md): use `sources/teams/`,
`sources/emails/`, `sources/calendar/`, or `sources/meetings/` respectively.
Those source pages are not semantic drafts and must not be placed under
`.voltmind/drafts`. The generic media storage rules below apply to other raw
files and do not override this connector-specific routing.

### Articles & Web Content

**Input:** URL shared by user, or article mentioned in conversation.

**Process:**
1. Fetch content (`web_fetch` or equivalent)
2. Extract: title, author, publication, date, full text
3. Summarize: executive summary + key arguments (not a rehash)
4. Extract entities: people, companies, concepts mentioned
5. **Save raw source** for provenance (see Raw Source Preservation below)
6. Analyze for the user: don't just summarize. What's interesting given what you
   know about them? Flag connections, contradictions, content opportunities.

**Write to:** appropriate directory per filing rules (about a person -> `people/`,
about a company -> `companies/`, reusable framework -> `concepts/`, raw data -> `sources/`)

### Videos & Podcasts

**Input:** URL (YouTube, podcast, etc.) or local audio/video file.

**Process:**
1. Get transcript -- speaker-diarized if possible (services like Diarize.io provide
   speaker-labeled, word-level timing)
2. **Save raw transcript** (both JSON and human-readable TXT)
3. Analyze: executive summary, key ideas, key quotes with speaker attribution,
   notable stories/anecdotes, people and companies mentioned
4. Extract and cross-reference all entities mentioned
5. **HARD RULE:** every video/podcast brain page MUST link to the raw diarized
   transcript. A page without transcript links is incomplete.

**Write to:** `media/videos/` or `media/podcasts/` with back-links to all entities.

**Quality bar:**
- Compelling headline (not "This video discusses...")
- Executive summary that makes you want to watch/listen
- Key Ideas as actual insights, not topic labels
- Verbatim quotes with real speaker names (not "speaker_0")
- All entities extracted with context and back-linked

### PDFs & Documents

**Input:** File path or URL.

**Process:**
1. Extract text (OCR if scanned/image PDF)
2. **Save raw source** for provenance
3. Summarize: executive summary + key sections + notable data
4. Extract entities
5. Cross-reference from entity pages

**Write to:** per filing rules (file by primary subject, not format).

### Screenshots & Images

**Input:** Image file.

**Process:**
1. Analyze content (OCR for text-heavy images, description for photos)
2. If tweet screenshot: extract text, author, date, route to social media workflow
3. If article screenshot: extract text, route to article workflow
4. If data/chart: extract data points, describe findings

**Write to:** depends on content -- route to the appropriate workflow above.

### Meeting Transcripts

**Input:** Transcript from meeting recording service, or manual notes.

**Process:**
1. Pull full transcript (source of truth -- AI summaries are medium-low trust)
2. **Save raw transcript** for provenance
3. Write meeting page with YOUR analysis above the line, raw transcript below
4. **Entity propagation (MANDATORY):** for each attendee and company discussed:
   - Update their brain page State section if new info surfaced
   - Append to their Timeline with link to the meeting page
   - Create page if person/company is notable and has no page yet
5. A meeting is NOT fully ingested until all entity pages are updated

**Write to:** `meetings/YYYY-MM-DD-short-description.md`

**What makes a good meeting page:**
- Reveals the real crux, not a bullet dump
- Connects to existing brain pages (people, companies, deals)
- Flags what changed (status, decisions, new info)
- Names tension or what was left unsaid
- Captures actual dynamic, not performative summary

### Social Media Content

**Input:** Tweet, thread, or social media post.

**Process:**
1. Fetch full content (thread, quote tweets, context)
2. If images present: OCR via vision model for full text extraction
3. Summarize: what's being said, why it matters, who's involved
4. Extract entities and update brain pages
5. Include direct link to the original post (MANDATORY for citations)

**Write to:** `media/x/` for daily aggregation, or entity-specific directories
if the post is primarily about a person/company.

## Raw Source Preservation

Every ingested item must have its raw source preserved for provenance.

**Use `voltmind files upload-raw` for automatic size routing:**
```bash
voltmind files upload-raw <file> --page <page-slug> --type <type>
```

- **< 100 MB text/PDF**: stays in git (brain repo `.raw/` sidecar directories)
- **>= 100 MB OR media** (video, audio, images): uploaded to cloud storage
  via TUS resumable upload, `.redirect.yaml` pointer left in the brain repo

The `.redirect.yaml` pointer format:
```yaml
target: supabase://brain-files/page-slug/filename.mp4
bucket: brain-files
storage_path: page-slug/filename.mp4
size: 524288000
size_human: 500 MB
hash: sha256:abc123...
mime: video/mp4
uploaded: 2026-04-11T...
type: transcript
```

**Accessing stored files:**
- `voltmind files signed-url <storage-path>` -- generate 1-hour signed URL for viewing/sharing
- `voltmind files restore <dir>` -- download back to local from cloud storage

Use `put_raw_data` in voltmind to store raw API responses and metadata (JSON, not binary).
