# Raw Teams Transcripts

This directory is the raw evidence layer for Microsoft Teams messages.

Rules:

- Preserve message text, sender, timestamp, attachment markers, and source references.
- Split one mixed chat episode into one file per coherent topic.
- Do not write summaries, project state, decisions, risks, or action plans here.
- Derived knowledge belongs in `projects/`, `meetings/`, `daily/`, or `state/` and must link back here.
- Redact credentials and secrets from the local evidence copy while preserving a note that the source message contained a credential.
