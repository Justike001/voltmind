# Craft Headless Runner for VoltMind Actions

## Summary

`craft_headless` is a VoltMind Action runtime that uses Craft as the headless
agent runner while keeping VoltMind as a thin harness. VoltMind launches Craft,
captures the `stream-json` event flow, writes logs and diagnostics, atomically
writes `result.json`, and lets the existing watcher/finalizer move the action
from `interactive_pending` to `done`, `blocked`, or `failed`.

The first version does not fork Craft and does not require the Craft agent to
write `result.json`.

## Capability Matrix

| Area | Craft role | VoltMind harness role |
|---|---|---|
| Process lifecycle | `craft-cli run` executes the prompt | Spawn, timeout, event capture, diagnostics |
| Workspace | Uses `--workspace-dir <actionDir>` | Creates action dir and writeback envelope |
| Session audit | Keeps Craft session with `--no-cleanup` | Stores launcher, stdout, stderr, transcript, events |
| Event stream | Emits `--output-format stream-json` | Parses JSONL and maps terminal state |
| Result writeback | Emits final text markers | Writes `result.json.tmp` then renames to `result.json` |
| Finalization | No direct DB writes | Existing watcher/finalizer validates nonce/source/slug |
| Sources and skills | Uses configured Craft sources/skills | Passes optional source slugs and injects action context |
| Safety | Follows fat skill policy | Fails closed when result/source/tool signals are missing |

## CLI Shape

The default launch is:

```powershell
$env:CRAFT_CONFIG_DIR = '<actionDir>\.craft-config'
craft-cli run --workspace-dir <actionDir> --output-format stream-json --no-cleanup
```

The prompt is sent on stdin. Local development can point VoltMind at a source
checkout without forking Craft:

```powershell
$env:VOLTMIND_CRAFT_REPO = 'E:\CraftAgent\craft-agents-oss'
```

or directly at a CLI entry:

```powershell
$env:VOLTMIND_CRAFT_CLI_ENTRY = 'E:\CraftAgent\craft-agents-oss\apps\cli\src\index.ts'
```

Optional Craft source slugs can be supplied with:

```powershell
$env:VOLTMIND_CRAFT_SOURCE_SLUGS = 'outlook-email,teams'
```

## Event Mapping

| Craft event | VoltMind behavior |
|---|---|
| `text_delta` or text-bearing event | Append transcript and parse final markers |
| `tool_start` / `tool_result` | Append diagnostic `craft_event_seen` |
| `complete` / `completed` | Write `status: done` unless markers say otherwise |
| `interrupted` | Write `status: blocked` |
| `error` / non-zero exit | Write `status: failed` |
| timeout | Emit `craft_timeout`, write `status: failed` |

Final markers are optional but preferred:

```text
VOLTMIND_RESULT_STATUS: done | blocked | failed
VOLTMIND_RESULT_SUMMARY: one concise sentence
VOLTMIND_ARTIFACT_REF: artifact path, slug, URL, or connector draft id
VOLTMIND_ERROR: short error or blocking reason
```

## First-Version Assumptions

- Use Craft CLI `run` before embedding a server SDK.
- Always set an isolated `CRAFT_CONFIG_DIR`.
- Always pass `--no-cleanup` for session audit.
- Keep `result.json` writeback in VoltMind.
- Keep finalization tied to a real validated `result.json`.
- Do not assume Craft can reuse Codex connector sessions; Craft sources need
  their own configuration.
