# Source Acquisition and Raw Preservation

Read this reference for every ingest that captures source material.

## Contents

- Evidence-first acquisition
- Raw storage routing
- Media/source-specific capture
- Batch quality gate

## Evidence-first acquisition

Persist raw evidence before any derived page. A source page must retain the
exact observed content, stable source identity, occurrence date, and available
event/version fields. Derived pages cite this evidence; later clarification is
separate provenance and must not rewrite the raw source as if it contained the
answer.

For client-authored Teams/Outlook ingest, write source Markdown locally first.
For server compatibility ingest, `ingest_capture` imports the event content as a
source snapshot. A remote database write is not a substitute for a required
local source page.

## Raw storage routing

Use `voltmind files upload-raw <file> --page <slug> --type <type>`:

- Text/PDF below 100 MB stays in the brain repo under the page's `.raw/`
  sidecar.
- Media or files at least 100 MB use resumable cloud storage and leave a
  `.redirect.yaml` pointer.
- Preserve structured API responses with `put_raw_data` when appropriate.
- SharePoint/OneDrive and mapped-drive items are metadata references by default;
  do not copy the binary unless materialization is explicitly requested.

## Source-specific capture

- Article/web: preserve title, author, publication, date, URL, and fetched text.
- Video/podcast: preserve the diarized transcript; every derived page links it.
- PDF/document: preserve the original file or durable pointer, then OCR/extract.
- Screenshot/image: preserve the image, OCR or describe it, then route by the
  content's primary subject.
- Meeting: preserve the full transcript or notes before writing analysis.
- Social content: preserve the original URL, post/thread text, author, date, and
  image OCR when applicable.

File by primary subject, not merely by format. Specialized workflows
`idea-ingest`, `media-ingest`, and `meeting-ingestion` provide the detailed
analysis conventions.

## Batch quality gate

For bulk work, process 3–5 samples first. Inspect titles, citations, raw links,
entity extraction, backlinks, and filing. Fix the workflow before continuing;
then batch with throttling and small commits.
