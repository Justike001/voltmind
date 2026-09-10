# Local action scheduling CLI

The local CLI handles queue discovery and persistence after each interview
answer. It makes no model, database, network, or scheduler calls.

Installed CLI: `voltmind actions schedule <command>`.
Source checkout: `bun scripts/action-schedule.ts <command>`.
Windows wrapper (also resolves the user-scoped vault setting):

```powershell
powershell -NoProfile -File scripts/action-schedule.ps1 queue
powershell -NoProfile -File scripts/action-schedule.ps1 show state/actions/example
powershell -NoProfile -File scripts/action-schedule.ps1 decide --file decision.json
```

Use `--vault PATH` to explicitly choose the exact local source repository.
Otherwise the process environment `VOLTMIND_LOCAL_BRAIN_VAULT` is required.
No database source selection or cross-source guessing takes place.

After reading `show` and resolving the cited local raw evidence, save the
authorized answer as UTF-8 JSON. Copy the actual `sha256` from `show`:

```json
{
  "slug": "state/actions/example",
  "expected_sha256": "COPY_SHA256_FROM_SHOW",
  "decision": "reminder",
  "source": "User, 2026-09-10",
  "note": "Keep as a reminder only"
}
```

| Decision | Result |
| --- | --- |
| `update` | Requires current status in `note`, a future `run_at` such as `2099-10-10T10:00:00+08:00`, and `timezone` such as `Asia/Shanghai`. Saves requested time, keeps open. |
| `reminder` | Keeps open, switches to manual and ineligible, removes executable schedule fields, excludes from scheduling interviews. Creates no reminder automation. |
| `obsolete` | Sets canceled, disables eligibility, removes executable schedule fields. |
| `skip` | Leaves every byte unchanged. |

`decide` returns a write receipt and the next candidate, so an agent need not
rescan the queue after each answer. Retain the original evidence packet until
its source changes. For a session containing skips, pass
`--exclude state/actions/example,state/actions/another` on subsequent calls.
Exclusions are session input, not a permanent action mutation.

`--dry-run` previews proposed Markdown without changing the action. A stale
hash rejects the write. A per-action exclusive lock prevents competing CLI
writes; after a crashed process, verify no writer is active before removing
its `.schedule.lock` file. Files are replaced atomically in UTF-8; body content
and unrelated YAML values are retained, but YAML formatting/comments may be
normalized by serialization.

The agent still interprets evidence, asks for missing information, confirms the
execution contract and uses the Desktop automation tool. The CLI never treats
choosing a date as execution approval. An existing automation ID requires
reconciliation before a non-skip decision; do not erase IDs to bypass this.
After successful registration, the agent persists the returned ID and normalized
schedule using the schedule-actions workflow. Remote sync is explicitly deferred
in the receipt and handled as a best-effort exact-file post-step by the agent.
