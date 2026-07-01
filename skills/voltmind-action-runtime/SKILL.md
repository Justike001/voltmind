---
name: voltmind-action-runtime
description: Execute VoltMind Admin Action prompts in a headless runner while leaving result writeback to the VoltMind adapter.
---

# VoltMind Action Runtime

Use this skill when Craft is running a VoltMind Action through the `craft_headless`
runtime. Craft is the headless agent runner. VoltMind is the harness that owns
dispatch, isolation, event capture, result writeback, and finalization.

## Runtime Contract

1. Read the action prompt and `request.json`.
2. Treat `plan_context_snapshot` in `request.json` as the preferred runtime
   context. Do not re-query VoltMind unless the snapshot is missing or
   insufficient.
3. Use the prompt sections `Action Tool Route`, `Persisted Action Plan`, and
   `Admin Plan Runtime Context` as authoritative launch context.
4. Map the `Action Tool Route` to available Craft sources and skills. If a
   required source is missing, finish as blocked or failed instead of pretending
   the action was completed.
5. Create reviewable artifacts in the action workspace or through configured
   draft-only connector tools.
6. Do not write `result.json`. The VoltMind adapter writes it from Craft events.

## Safety Boundary

- Prefer draft creation over send/write operations.
- Do not send email, post Teams messages, mutate external systems, or approve
  irreversible changes unless the prompt explicitly says the action is confirmed
  and allowed.
- If the available source surface is read-only when a draft/write tool is
  required, fail closed.
- Keep private connector IDs, tokens, cookies, and raw secrets out of artifacts
  and summaries.

## Artifact Norms

- Name workspace artifacts with short descriptive filenames.
- For email or Teams work, create a draft artifact or connector draft ID rather
  than claiming a message was sent.
- Include enough review context for the user to understand what was prepared,
  what source context was used, and what remains blocked.

## Final Response Markers

End with concise machine-readable markers. The adapter uses them for summary
extraction but still owns `result.json`.

```text
VOLTMIND_RESULT_STATUS: done | blocked | failed
VOLTMIND_RESULT_SUMMARY: one concise sentence
VOLTMIND_ARTIFACT_REF: optional artifact path, slug, URL, or connector draft id
VOLTMIND_ERROR: optional short error or blocking reason
```

Use `done` only when the requested draft or artifact exists and is safe for
review. Use `blocked` when user input, credentials, source configuration, or
approval is needed. Use `failed` for unrecoverable runtime or tool errors.
