# Follow-up task C — Worker queue-consume paths must scope RLS reads (restricted-role completion)

**Status: DONE (implemented + verified; deployed-state confirmation pending next rollout)**
**Owning area:** `src/core/minions/queue.ts`, `src/core/minions/worker.ts`
**Authored from:** production outage post-mortem + option revert to restricted role.

---

## TL;DR

Task B fixed the **enqueue** side of the FORCE-RLS `minion_jobs` policy (callers now pass
`submitSourceId` → `setSourceScope` so the INSERT satisfies the write policy). But the
**consumer side — `MinionWorker` — still runs its queue methods without a source scope**,
so under the restricted (non-BYPASSRLS) runtime role every worker-side queue operation
(claim, stall recovery, timeouts, fail/complete, etc.) is RLS-filtered to **0 rows**. The
net production state after the B revert is: autopilot **can enqueue** jobs but the worker
**cannot claim or advance them** — the queue fills with `waiting` jobs that never run.

This task makes the worker's queue consumption source-aware so the whole cycle
(enqueue → claim → run → complete) works under `voltmind_restricted`.

---

## Scope of the gap (verified)

`MinionQueue` methods called by the worker (`src/core/minions/worker.ts` main loop +
launch bookkeeping) — every one runs `this.engine.transaction(async tx => ...)` but
**never installs a source scope** in that transaction. Under RLS (`voltmind_restricted`,
`rolbypassrls = f`) each `minion_jobs` access filter to rows where `source_id =
app.source_id`; with no scope the GUC is NULL-NULL comparison → 0 rows.

### Worker → queue call sites (must be scoped)

| # | file:line | method | RLS-risk |
|---|---|---|---|
| 1 | `worker.ts:223` | `ensureSchema()` | CREATE exempt? (DDL, RLS may not filter; verify) |
| 2 | `worker.ts:245` | `handleStalled()` | read + UPDATE waiting/active → **0 rows, silent** |
| 3 | `worker.ts:252` | `handleTimeouts()` | UPDATE dead rows |
| 4 | `worker.ts:258` | `handleWallClockTimeouts()` | UPDATE active |
| 5 | `worker.ts:435` | `promoteDelayed()` | UPDATE waiting |
| 6 | `worker.ts:443` | `claim()` | **the big one** — UPDATE waiting→active; 0 rows blocks all claim |
| 7 | `worker.ts:627+` | `renewLock()` | UPDATE active |
| 8 | `worker.ts:530` | `cancelJob()` | UPDATE/DELETE |
| 9 | `worker.ts:783/909/987` | `failJob()` | UPDATE → dead |
| 10 | `worker.ts:845` | `completeJob()` | UPDATE → completed |
| 11 | `worker.ts:801/804` | `updateProgress/updateTokens` | UPDATE |
| 12 | `worker.ts:823` | `readInbox()` | SELECT |

All live in `src/core/minions/queue.ts` at lines: claim 620, handleStalled 1143,
handleTimeouts 659, handleWallClockTimeouts 732, promoteDelayed 1132, completeJob 809,
failJob 917, renewLock 1121, cancelJob 451 (each wraps in `engine.transaction`).

## Design decision (READ THIS FIRST — do not guess)

**Decision: Option B — per-method transaction-local source scope (implemented in this task).**

There are two valid mental models for worker scoping, and the right one depends on
whether the **worker is meant to be global** (one prime, watches ALL sources) or
**per-source**. Today the worker is the single company-server worker
(`jobs work --concurrency 3 --runtime-role company-server`) and the fan-out cycle
submits **per-source** `autopilot-cycle` jobs. So:

- **Option A — worker installs admin scope for the whole run** (mirror `dispatchPerSource`):
  **REJECTED after the required minimal reproduce.** `setAdminSourceScope()` (and
  `setSourceScope`/`setSourceReadScope`) all call `set_config(..., true)` = SET LOCAL
  (transaction-scoped). Calling `setAdminSourceScope()` OUTSIDE an explicit
  `engine.transaction` throws `source_scope_not_applied` (verified against a real
  non-BYPASSRLS role in the repro). The worker's `start()` runs outside a transaction,
  so a single outer-loop install is impossible.

  Even INSIDE a transaction, admin scope only enables WRITES to the FIRST source:
  `setAdminSourceScope` sets the scalar `app.source_id` = `unique[0]`, and the
  FORCE-RLS write policy (`voltmind_source_write_scope_contains`) compares the row's
  `source_id` to the SCALAR `app.source_id`. Verified: an admin-scoped claim UPDATE
  matches 0 rows for a job whose source is not the first. So Option A cannot claim
  cross-source jobs even if it were installed correctly.
- **Option B — per-method transaction-local scope** (IMPLEMENTED): every worker→queue
  method installs its scope inside the transaction that owns the write. Because the
  write policy is scalar-single-source:
  - job-specific writes (`completeJob`, `failJob`, `renewLock`, `cancelJob`,
    `updateProgress`, `updateTokens`, `readInbox`, `releaseLeaseFullJob`,
    `releaseRecoverableConnectionJob`) install the scope for THAT job's source;
  - `claim()` is a two-hop inside one transaction: admin READ scope picks the
    candidate across all sources, then the write scalar is narrowed to the
    candidate's source and the UPDATE claims by id (guarded on `status='waiting'`
    for atomicity, since admin-scope FOR UPDATE cannot lock a non-first source);
  - the cross-source bulk sweeps (`handleStalled`, `handleTimeouts`,
    `handleWallClockTimeouts`, `promoteDelayed`) run one scoped pass PER SOURCE
    (write scalar is single-source, so a sweep that must reach every source's
    rows iterates the source list) and merge results.
  - Under the default BYPASSRLS `postgres` app role and PGLite, RLS never fires
    and every scoped helper is a no-op: the legacy code path is preserved
    byte-for-byte (verified: 172 PGLite minions tests + full postgres e2e suites
    stay green).
- **Option C — claim-only fix**: rejected — leaves stall/timeout/promote dead under
  the restricted role, which the acceptance criteria explicitly require.

## Minimal reproduce (required by the decision, executed before choosing)

1. `set_config(name, val, true)` is transaction-local (SET LOCAL): a value set in
   one statement evaporates in the next outside an explicit transaction; `false`
   is session-scoped (verified on the live restricted pool).
2. `setAdminSourceScope()` OUTSIDE a transaction → throws `source_scope_not_applied`;
   INSIDE a transaction → works (verified via `voltmind_e2e_runtime`).
3. Admin-scoped claim on a NON-first source → 0 rows; per-job `setSourceScope(source)`
   → 1 row (verified: admin scalar = first source only).
4. Full worker claim→run→complete under a non-BYPASSRLS role now works end-to-end
   (verified by `test/e2e/autopilot-rls-worker-scope.test.ts`).

## Regression test (required)

Instrument with a test that, under a **non-BYPASSRLS role**:
1. seeds a `minion_jobs` `waiting` row for a known `source_id`
2. runs `MinionWorker` (or the specific queue methods) via a `voltmind_restricted`-style
   engine
3. asserts the job IS claimed / advanced (positive)
4. negative control: a worker WITHOUT the scope selection leaves the same row untouched

Reuse the `provisionHttpRuntimeDatabaseUrl()` helper to mint a NoBypass role URL
(`voltmind_e2e_runtime`), and read back results via the PRIVILEGED engine (the restricted
role itself can't read what it can't scope, as with B). Name:
`test/e2e/autopilot-rls-worker-scope.test.ts` (or add to `autopilot-rls-scope.test.ts`).

Test-only .e2e pattern already exists from B — see `test/e2e/autopilot-rls-scope.test.ts`
for the establish harness.

## Interplay / keeping the current revert working

Do **not** partially revert client-visible production while task C is in-flight unless the
new worker test passes. Current deployed state (this issue from B's outcome):
- pool `datatun URL = voltmind_restricted` (restored); direct URL = postgres
- worker starts but never claims (queue accumulates waiting)
If C cannot be landed safely in-session, the operator should:
1. either stay on `voltmind_restricted` (RLS backstop ON, worker blocked) and plan C as
   the immediate next step
2. or revert pool to `postgres` (hotfix, worker RUNS but RLS off) and add C to the backlog.
Both are defensible; document which one you end on in the commit message.

**Posture this task ends on: stay on `voltmind_restricted`** — task C lands the worker-
consume scoping (option B) so the restricted role is the production posture going forward
(RLS backstop ON, worker claims/runs/completes). The next production rollout ships this
build; the deployed-state confirmation (worker actually processing jobs, no REL errors
in `autopilot.err`) is the last acceptance checkbox.

## Acceptance criteria

- [x] A decide (Option A/B/C documented; implement accordingly) — **Option B**,
      decision + minimal reproduce documented above.
- [x] Worker under a restricted role claims/runs/completes a real `waiting` job.
      (verified: `test/e2e/autopilot-rls-worker-scope.test.ts`, full claim→run→complete).
- [x] All worker→queue methods (stall/timeout/promote/claim/complete) no longer hit
      RLS-rule naturally blocked 0-row state. (verified per-source multi-source tests
      for promoteDelayed / handleTimeouts / handleWallClockTimeouts / handleStalled).
- [x] New restricted-verse test passes (positive + negative). `test/e2e/autopilot-rls-worker-scope.test.ts`
      (6 tests: 1 full worker e2e + 4 multi-source sweeps + 1 negative control).
- [x] Existing worker unit + e2e suites still green: `bun test test/minions*.test.ts`
      (172), worker-pool, queue-child-done, quiet-hours, lease-full-retry, rss,
      shutdown-disconnect, `test/e2e/autopilot-fanout-postgres.test.ts`,
      `test/e2e/autopilot-rls-scope.test.ts` — 269 pass / 0 fail in the focused gate.
- [ ] Autopilot with `restricted` runtime.env shows worker actually processing jobs,
      with no `new row ... REL` error in `autopilot.err` (confirm on the real service).
      — Deployed-state confirmation, run after the next production rollout of this
      build.

## Implementation notes (v0.42 task C)

- `src/core/minions/queue.ts`: added `rlsEnforced()` (detects rolbypassrls=false on
  the connection's CURRENT_USER, cached), `txScopeRead`/`txScopeWrite` (transaction-local
  scope installers that no-op when RLS isn't enforced), `allSourceIds()`
  (`voltmind_admin_source_ids()` SECURITY DEFINER), `scopeJobTx(tx, id)` (resolve the
  job's source under admin read scope, then narrow the write scalar), `runJobWrite` and
  `runSweepPerSource` wrappers. `claim` two-hops; `completeJob`/`failJob`/`cancelJob`
  scope to the job source inside their existing transaction; `renewLock`/updateProgress`/
  `updateTokens`/`readInbox`/release* wrap in a scoped tx; the four sweeps iterate per
  source. `handleStalled` keeps the legacy single pass under BYPASSRLS/PGLite.
- `src/core/minions/worker.ts`: quiet-hours defer/skip, handler `context.log`/`isActive`
  run through `queue.withJobSourceScoped(job.id, ...)` (direct engine.executeRaw calls on
  minion_jobs were themselves RLS-filtered); the health stall wait-count routes through
  `queue.countWaitingForNames` (kept on bare executeRaw so probe-engine unit tests keep
  intercepting it).
- Why not session scope: the worker uses a pooled Postgres connection (module singleton,
  no poolSize), so a session GUC set outside a transaction is unreliable; transaction-&
  local `set_config(..., true)` inside each method is the codebase's sanctioned pattern.
- PGLite/test-fidelity: PGLite `transaction()` clones `this`; when the engine is a test
  proxy that intercepts `executeRaw`, the clone routes back to the main connection while
  the tx is open (deadlock). Hence the legacy (non-RLS) path keeps the original bare
  executeRaw / single-transaction shapes.

## Backups / source of truth

State preserved as of this task's writing: `runtime.env.bak-*` (before the restricted
revert), `.deploy/df14e90b`, `.deploy/voltmind-0.41.21.3.bak`. Do not delete.