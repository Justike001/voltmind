# Live Sync: Keep the Index Current

## Goal

Every markdown change in the brain repo is searchable within minutes, automatically, with no manual intervention.

## What the User Gets

Without this: you correct a hallucination in a brain page, but the vector DB
keeps serving the old text because nobody ran `voltmind sync`. Stale search
results erode trust. The brain becomes unreliable.

With this: edits show up in search within minutes. The vector DB stays current
with the brain repo automatically. You never have to remember to run sync.

## Implementation

### Prerequisite: Session Mode Pooler

Sync uses `engine.transaction()` on every import. If `DATABASE_URL` points to
Supabase's **Transaction mode** pooler, sync will throw `.begin() is not a
function` and **silently skip most pages**. This is the number one cause of
"sync ran but nothing happened."

Fix: use the **Session mode** pooler string (port 6543, Session mode) or the
direct connection (port 5432, IPv6-only). Verify by running `voltmind sync` and
checking that the page count in `voltmind stats` matches the syncable file count
in the repo.

### The Primitives

Always chain sync + embed:

```bash
voltmind sync --repo /path/to/brain && voltmind embed --stale
```

- `voltmind sync --repo <path>` -- one-shot incremental sync. Detects changes via
  `git diff`, imports only what changed. For small changesets (<= 100 files),
  embeddings are generated inline during import.
- `voltmind embed --stale` -- backfill embeddings for any chunks that don't have
  them. Safety net for large syncs (>100 files) or prior `--no-embed` runs.
- `voltmind sync --watch --repo <path>` -- foreground polling loop, every 60s
  (configurable with `--interval N`). Embeds inline for small changesets. Exits
  after 5 consecutive failures, so run under a process manager or pair with a
  cron fallback.

### Approach 1: Cron Job (recommended)

Run every 5-30 minutes. Works with any cron scheduler.

```bash
voltmind sync --repo /data/brain && voltmind embed --stale
```

**OpenClaw:**
```
Name: voltmind-auto-sync
Schedule: */15 * * * *
Prompt: "Run: voltmind sync --repo /data/brain && voltmind embed --stale
  Log the result. If sync fails with .begin() is not a function,
  the DATABASE_URL is using Transaction mode pooler."
```

**Hermes:**
```
/cron add "*/15 * * * *" "Run voltmind sync --repo /data/brain &&
  voltmind embed --stale. Log the result." --name "voltmind-auto-sync"
```

### Approach 2: Long-Lived Watcher

For near-instant sync (60s polling). Run under a process manager that
auto-restarts on exit. Pair with a cron fallback since `--watch` exits
on repeated failures.

```bash
voltmind sync --watch --repo /data/brain
```

### Approach 3: Git Hook / Webhook

Triggers sync on push events for instant sync (<5s).

- **GitHub webhook:** Set up the webhook to call
  `voltmind sync --repo /data/brain && voltmind embed --stale`.
  Verify `X-Hub-Signature-256` against a shared secret.
- **Git post-receive hook:** If the brain repo is on the same machine.

### Microsoft connector relay

Teams/Outlook connectors can send normalized events to `POST /ingest/events`
after the VoltMind relay feature is explicitly enabled:

```bash
voltmind config set ingestion.microsoft_relay.enabled true
```

The connector, not VoltMind, owns Microsoft OAuth and delta cursors. Each event
may include validated SharePoint/OneDrive `file_refs`; VoltMind stores the
stable tenant/drive/item identity and projects the name/path into the page, but
does not download the file. Replays are safe by `(source, platform, event_id,
event_version)`. To analyze a file, use the SharePoint/OneDrive connector to
extract Markdown and call `file_ref_materialize`; the artifact keeps the
observed eTag and is marked stale when the file changes.

The same event can also carry a RaiDrive or mapped shared-drive reference:

```json
{
  "schema_version": 1,
  "provider": "filesystem",
  "service": "raidrive",
  "root_key": "synology-public",
  "relative_path": "Public/Finance/FY27 Planning.xlsx",
  "name": "FY27 Planning.xlsx",
  "availability": "accessible",
  "occurrence": {
    "platform": "teams",
    "relation": "mentioned",
    "conversation_id": "conversation-id",
    "message_id": "message-id",
    "source_uri": "teams://conversation/message"
  }
}
```

Use the same `root_key` for every user. Each thin client keeps its own drive
letter and username-specific UNC root in local file-plane configuration:

```bash
voltmind client-roots add synology-public \
  --local-root 'Z:\' \
  --unc-root '\\RaiDrive-CurrentUser\Synology'
voltmind client-roots test synology-public
```

The client converts local paths to `root_key + relative_path` before normal
ingestion, and resolves returned logical paths back to a local
`resolved_open_path`. The host does not persist the `Z:` mapping or the
username-bearing UNC host. A one-time remote backfill may send the drive-root
prefix and UNC share name as non-persisted matching hints for legacy page text;
it never sends the username-bearing UNC host. When the storage layer exposes a
stable file identifier, include it as `file_id` so renames and moves update one
reference. Without `file_id`, identity falls back to
`root_key + relative_path`, so rename/move continuity cannot be guaranteed.

For legacy pages, preview or apply reference indexing with:

```bash
voltmind file-refs backfill --dry-run
voltmind file-refs backfill

# On a configured thin client, local roots are normalized before the host scan.
voltmind file-refs backfill --dry-run --root-key synology-public
voltmind file-refs search 'Z:\Public\Finance\FY27 Planning.xlsx'

# Remove historical machine-specific paths after previewing the affected count.
voltmind file-refs scrub-open-paths --dry-run
voltmind file-refs scrub-open-paths --yes
```

### What Gets Synced

Sync only indexes "syncable" markdown files. These are excluded by design:
- Hidden paths (`.git/`, `.raw/`, etc.)
- The `ops/` directory
- Meta files: `README.md`, `index.md`, `schema.md`, `log.md`

### Sync is Idempotent

Concurrent runs are safe. Two syncs on the same commit no-op because content
hashes match. If both a cron and `--watch` fire simultaneously, no conflict.

### Failure History Recovery

Sync failures are stored in `~/.voltmind/sync-failures.jsonl`. A later clean
sync removes an open entry only when the same file succeeded in that run. The
`<head>` entry used for a git HEAD verification/timeout failure is removed only
after a complete run re-validates the same HEAD (including a clean no-op run).
Timeouts, blocked runs, and unrelated file failures do not clear it. Entries
explicitly acknowledged or auto-skipped remain as history.

## Tricky Spots

1. **Always chain sync + embed.** Running `voltmind sync` without
   `voltmind embed --stale` leaves new chunks without embeddings. They exist
   in the database but are invisible to vector search. Always run both
   commands together. The `&&` ensures embed only runs if sync succeeds.

2. **--watch polls, it doesn't stream.** The `--watch` flag polls every 60s
   (configurable). It is not a filesystem watcher or git hook. It exits after
   5 consecutive failures, so it needs a process manager (systemd, pm2) or a
   cron fallback to stay alive. Don't assume it runs forever.

3. **Webhook needs the server running.** If you use a GitHub webhook for
   instant sync, the receiving server must be running and reachable. If the
   server is down when a push happens, that sync is missed. Pair webhooks
   with a cron fallback that catches anything the webhook missed.

## How to Verify

1. **Edit a file and search for the change.** Edit a brain markdown file,
   commit, and push. Wait for the next sync cycle (cron interval or `--watch`
   poll). Run `voltmind search "<text from the edit>"`. The updated content
   should appear in results. If it returns old content, sync failed.

2. **Compare page count to file count.** Run `voltmind stats` and count the
   syncable markdown files in the brain repo. The page count in the database
   should match. If they diverge, files are being silently skipped (likely
   a Transaction mode pooler issue).

3. **Check embedded chunk count.** In `voltmind stats`, the embedded chunk
   count should be close to the total chunk count. A large gap means
   `voltmind embed --stale` isn't running after sync, leaving chunks invisible
   to vector search.

---

*Part of the [VoltMind Skillpack](../VOLTMIND_SKILLPACK.md).*
