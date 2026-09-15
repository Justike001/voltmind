---
name: google-loops
version: 1.0.0
description: |
  Set up and operate the Gmail/Calendar/Contacts connector and the open-loop
  engine: who is waiting on the user, what they promised, and the context
  needed to respond. Covers painless BYO OAuth setup (exactly two user
  interactions), the daily `voltmind waiting` digest, loop closing/muting, and
  troubleshooting via the typed error catalog.
triggers:
  - "connect gmail"
  - "connect google"
  - "connect calendar"
  - "connect contacts"
  - "who is waiting on me"
  - "what do I owe people"
  - "open loops"
  - "unanswered email"
  - "set up email ingestion"
  - "voltmind waiting"
tools:
  - open_loops
  - loops_close
  - loops_mute
  - entity
  - context_pack
mutating: true
writes_pages: false
---

## VoltMind thin-client boundary

- **Semantic writes:** Durable brain-page, fact, and entity writes go through the thin-client local `voltmind put` workflow with source attribution. A remote `put_page` call must not substitute for this client-first evidence write.
- **Expanded capabilities:** `entity` is the zero-LLM structured entity-card operation; `synthesize` is the slower, LLM-backed cross-page reasoning operation. Both are available to thin clients over read-scoped MCP and must retain their distinct cost and latency semantics.
- **Google open-loop boundary:** Google open-loop product capabilities are deliberately not introduced into VoltMind MCP. Keep `open_loops`, `loops_close`, and `loops_mute` capability-gated; OAuth and connector setup remain Host/local harness work.
- **Host/local harness workflows:** `sync`, `embed`, `extract`, `transcripts`, `files`, `lsd`, DB repair, and Git history rewrite run in the Host or local harness workflow. They are not thin-client MCP tools.
- **Harness prerequisites:** External web access, Git, shell/exec/read tools, and raw filesystem access are harness prerequisites supplied by the executing host/workspace. They must not be presented as VoltMind MCP capabilities.


# Google Loops — Setup and Daily Operation

The connector ingests Gmail threads, calendar events, and contacts into the
brain and maintains the open-loop record behind `voltmind waiting`. Full
references: `docs/guides/google-connect.md` (setup + every error and its
fix) and `docs/guides/open-loops.md` (how detection works).

## Contract for the harness (read first)

1. **Relay `[SHOW USER]` blocks verbatim.** Setup commands print fenced
   `[SHOW USER] ... [/SHOW USER]` blocks — numbered steps with deep links.
   Pass them to the user unchanged (paraphrasing loses load-bearing detail
   like "Desktop app, NOT Web application"). Batch everything into ONE
   message per block.
2. **The whole setup is exactly two user interactions.** (1) The Google
   Cloud checklist + the user hands back the downloaded client JSON.
   (2) The user clicks one consent URL. If you find yourself asking a third
   question, re-read the block you skipped.
3. **Never put secrets in argv or chat when avoidable.** When the user drops
   `client_secret_*.json` into chat, save it to a file (mode 0600) and pass
   the path: `voltmind google connect --client-json <path>`. Env
   (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`) also works. Raw
   `--client-id/--client-secret` flags are the last resort.
4. **Every command speaks JSON.** Add `--json` and read
   `{ ok, status, next_action: { command, user_message }, error }`. When
   `next_action.user_message` is present, that IS the message to show the
   user; when `next_action.command` is present, that is your next call.
   Errors carry `{ code, problem, cause, fix, doc_url }` — show the user
   `problem` + `fix`, nothing else.
5. **Re-running is always safe.** `voltmind google connect` and
   `voltmind google setup` are idempotent state machines — the documented fix
   for most errors is "run it again."

## Setup (the one command)

```bash
voltmind google setup --json
```

Handles: credential intake (prints the GCP checklist when nothing is on
file) → consent (loopback locally; auto paste-back over SSH/headless —
non-TTY flows complete via a second call:
`voltmind google connect --code "<pasted-redirect-url>"`) → source
registration → a budgeted first sync (newest mail first; the deep backfill
resumes on later syncs automatically) → the first `voltmind waiting` digest.

Multiple accounts: repeat with `--account work@example.com`.

Already holding Google access another way (a Google CLI with its own auth,
`gcloud`, a credential gateway that mints tokens)? Skip OAuth and point the
source at it — no credential enters voltmind:

```bash
voltmind sources add gmail-work --kind google --account you@example.com \
  --access command --token-command "<command that prints an access token>"
```

(`--access env --token-env <VAR>` reads an externally-refreshed token from
the environment instead.) Then `voltmind sync --source gmail-work` and
`voltmind waiting` work identically.

Verify health afterwards: `voltmind google status --json` (per-account
refresh probe) — and `voltmind doctor` carries a `google_oauth` check that
warns once a Testing-mode account goes 5+ days without a successful
refresh. An actively-syncing account gets no pre-warning before the 7-day
Testing-mode expiry — publishing to Production is the real fix.

## Daily operation

```bash
voltmind waiting --json        # the killer output: ranked people waiting
voltmind loops done <id>       # user handled it
voltmind loops drop <id>       # user is not going to do it
voltmind loops mute sender <email>   # never track this sender again
```

- `waiting` REFUSES on stale data (no successful sync in 24h) and names the
  exact fix (`voltmind sync --source <id>`). Run the sync, then retry. Only
  use `--stale-ok` when the user explicitly accepts stale results.
- When presenting loops, show: the counterparty, what's owed (summary), the
  evidence quote, the deep link (opens the exact Gmail thread in the right
  account), and the due date when present. The trusted-local result already
  carries a paste-ready `text` digest — reuse it.
- For "context to respond": each group carries the counterparty's entity
  card (summary, recent history, other open threads). Need more, call
  `context_pack` with the counterparty slug.
- After the user says they replied/handled something, close the loop
  (`loops done`) — thread loops also self-close on the next sync when the
  reply is visible in Gmail.

## Continuous ingestion

Google sources sync like any source: autopilot and `voltmind sync --all` pick
them up automatically. No cron of its own. A bare un-targeted `voltmind sync`
does NOT reach them — use `--source <id>` or `--all`.

## Troubleshooting

Every failure has a typed code with the fix attached —
`docs/guides/google-connect.md#troubleshooting` is the canonical table. The
three the user will actually hit:

- **"Google hasn't verified this app"** during consent → expected; it's the
  user's own app: Advanced → Continue. Warn them BEFORE they click the URL.
- **`access_denied_test_user`** → they forgot to add themselves as a test
  user (the error carries the deep link).
- **`invalid_grant_testing_expiry`** (everything silently stopped ~day 7) →
  their consent screen is still in Testing; publish to Production, then
  `voltmind google connect --reauth <email>`.

## Cost honesty

Commitment extraction sends recent email text (≤30 days, ≤50 threads/sweep)
to the configured chat provider. Tell the user once during setup; the off
switch is `voltmind config set loops.extraction_enabled false`. The
unanswered-thread detector is free and unaffected.

## Output Format

When relaying `voltmind waiting`, present per counterparty, most urgent first:

```
## <Counterparty> (<N> open)
- [<loop_type>] <what's owed> (<age>) — due <date if any>
  > "<evidence quote>"
  <Gmail deep link>
```

The trusted-local `--json` result already carries this as a paste-ready
`text` field — prefer relaying it over re-rendering. For setup commands,
relay `[SHOW USER]` blocks verbatim and `error.problem` + `error.fix` on
failures; never dump raw JSON envelopes at the user.

## Anti-Patterns

- **Paraphrasing a `[SHOW USER]` block.** The checklists carry load-bearing
  detail ("Desktop app, NOT Web application", the test-user step). Relay
  verbatim, one message per block.
- **Asking the user for client_id/client_secret as chat text.** Take the
  downloaded JSON as a 0600 file (`--client-json <path>`) or env vars;
  secrets in argv/chat are the last resort, never the default.
- **Answering "who is waiting on me" from `query`/`search`.** The open-loop
  record is `open_loops` / `voltmind waiting` — search results have no
  loop-state semantics and will happily surface answered threads.
- **Bypassing the staleness refusal with `--stale-ok` silently.** Run the
  named `voltmind sync --source <id>` first; only pass `--stale-ok` when the
  user explicitly accepts possibly-outdated loops.
- **Marking loops done for the user.** Close (`voltmind loops done <id>`) only
  after the user says it's handled; thread loops self-close on the next sync
  when the reply is visible in Gmail.
