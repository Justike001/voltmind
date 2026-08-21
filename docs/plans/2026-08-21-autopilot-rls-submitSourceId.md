# Follow-up task B — Autopilot enqueue under restricted role must set source scope

**Status:** DONE (implemented + tested 2026-08-21)
**Owning area:** `src/commands/autopilot.ts`, `src/commands/autopilot-fanout.ts`, `src/core/minions/queue.ts`
**Authored from:** production outage on the personal host (8/20 05:53–06:33 UTC, cycle-failure-cap auto-stop).

---

## TL;DR

`MinionQueue.add()` already accepts a 5th parameter `submitSourceId` that sets the
`app.source_id` session GUC inside the enqueue transaction so the INSERT satisfies
the FORCE-RLS policy on `minion_jobs` (queue.ts:97, applied at queue.ts:149–151).
**The autopilot enqueue paths never pass it**, so when the app connects as a
non-`BYPASSRLS` role (`voltmind_restricted`), every `autopilot-cycle` enqueue dies
with `new row violates row-level security policy for table "minion_jobs"`.

This task wires `submitSourceId` into the three autopilot enqueue call sites and adds
a restricted-role regression test that proves the fixed path satisfies the RLS policy.

---

## Background & why this matters

The full RLS model (migrations v112/v124/v130/v133 + schema.sql) is built to let the
app run on a **non-BYPASSRLS restricted role** and isolate reads/writes by
`source_id`, keyed off the `app.source_id` session GUC (fail-closed when unset).
`postgres` (BYPASSRLS) bypasses every policy, which is why the current live hotfix
(pool URL pointed at `postgres`) makes RLS "inert" — service restored, but the
row-isolation backstop is off for the whole runtime surface.

The correct end state (this task) is:
> pool connection returns to `voltmind_restricted` (RLS active), and every enqueue
> path carries the explicit source scope so the INSERT policy passes.

`setSourceScope` already exists and is used correctly by the MCP/HTTP path via
`withOperationSourceScope` (src/mcp/dispatch.ts:105–125). Autopilot simply failed to
adopt the same mechanism.

## Call sites to patch (3)

| File:line | Call | Current source id | Patch |
|---|---|---|---|
| `src/commands/autopilot.ts:214` (`submitVerificationCycle`) | `queue.add('autopilot-cycle', {repoPath, pull:false}, {...})` | legacy single-source; resolve via same spec as the fan-out default | add `submitSourceId` = default source id |
| `src/commands/autopilot-fanout.ts:180` (legacy fallback, `sources.length===0`) | `queue.add('autopilot-cycle', {repoPath}, {...})` | no `source_id` row; use `DEFAULT_SOURCE_ID` | add `submitSourceId` = `DEFAULT_SOURCE_ID` |
| `src/commands/autopilot-fanout.ts:205` (per-source fan-out) | `queue.add('autopilot-cycle', {repoPath, source_id: src.id, pull}, {...})` | `src.id` already in `data` | add `submitSourceId` = `src.id` |

**Signature** (already exists — no queue change needed):

```ts
async add(
  name: string,
  data?: Record<string, unknown>,
  opts?: Partial<MinionJobInput>,
  trusted?: TrustedSubmitOpts,
  submitSourceId?: string,        // <-- sets app.source_id in enqueue tx (queue.ts:97)
)
```

Confirm at patching time that `submitSourceId` is the **5th positional arg** (after
`trusted`); the current call sites pass 3 args, so adding a 4th/5th is back-compatible.

## Source id resolution rules

- **Per-source fan-out** (`src.id`): use `src.id` directly — it is already threaded
  into `data.source_id`, so the scope must match it or the insert fails.
- **Legacy paths** (`submitVerificationCycle`, `sources.length===0` fallback): the
  canonical single-source id is `DEFAULT_SOURCE_ID = 'default'`
  (src/core/sync-failure-ledger.ts:21). Import and use it; do not hardcode the string.
- Do NOT set scope when the engine is **PGLite** — PGLite `setSourceScope` is a no-op
  and has no RLS; setting it is harmless but pointless. If the code can't cheaply
  branch, passing `'default'` is fine because the PGLite tx does nothing with it.
  Prefer readability; gate only if the existing fanout logic already branch per-kind.

## Regression test (required)

Add a Postgres-backed test that runs the enqueue **as a non-BYPASSRLS role** and
asserts the INSERT policy passes when the call site sets `submitSourceId`, and fails
(deliberately) when it does not.

Approach (mirror `test/e2e/autopilot-fanout-postgres.test.ts` harness):
1. Provision a `voltmind_restricted`-style role (no `BYPASSRLS`) that has GRANTs on
   `minion_jobs` INSERT.
2. Connect a `PostgresEngine` AS that role (via a `DATABASE_URL` pointing at the
   restricted/user, OR `SET ROLE`).
3. Ensure `minion_jobs` is FORCE-RLS and has the `app.source_id` policy (already the
   schema state after migrations 124/130).
4. `dispatchPerSource` (and/or `submitVerificationCycle`) with fan-out → assert jobs
   are inserted (`minion_jobs` row exists, `source_id` matches).
5. Negative control: remove the `submitSourceId` arg (or a direct `queue.add` without
   it) under the same restricted role → assert the RLS `new row violates` failure.

**Where**: extend `test/e2e/autopilot-fanout-postgres.test.ts` OR add
`test/e2e/autopilot-rls-scope.test.ts` (choose based on whether a restricted-role DB
URL is available in the harness; e2e helpers read `DATABASE_URL`).

**Gate note**: the app must run the restricted role over the pooler (6543) for the
policy to fire. A plain `postgres` (BYPASSRLS) test harness will show the insert
"passing" even without the patch — that's a false green. The negative control (raw
`queue.add` without scope) must show the RLS failure to prove the harness actually
enforced the policy.

## Rollback / interplay with the current hotfix

While this task is BACKLOG, the production hotfix (option A: pool URL role
`voltmind_restricted` → `postgres`) stays in place. Once this patch lands and the
regression test is green, revert the hotfix:
- `runtime.env`: `VOLTMIND_DATABASE_URL` role back to `voltmind_restricted.your-tenant-id`
  with its original password (restore `runtime.env.bak-<ts>`).
- Restart `systemctl --user restart voltmind-autopilot.service`.
- Verify enqueue succeeds under the restricted role (autopilot.log shows `[dispatch] job #...` without the RLS error).

Backup/rollback points that must remain untouched while this task is in flight:
- `.deploy/df14e90b/` (0.41.20.0 pre-built snapshot)
- `.deploy/voltmind-0.41.21.3.bak` (pre-upgrade bin)
- `~/.config/voltmind/runtime.env.bak-20260821-035741` (pre-hotfix connection config)

## Acceptance criteria

- [ ] `src/commands/autopilot.ts` `submitVerificationCycle` passes `submitSourceId` (default source).
- [ ] `src/commands/autopilot-fanout.ts` legacy fallback passes `submitSourceId` (`DEFAULT_SOURCE_ID`).
- [ ] `src/commands/autopilot-fanout.ts` per-source fan-out passes `submitSourceId` (`src.id`).
- [ ] No regression in existing fan-out tests (`autopilot-fanout.test.ts`, `autopilot-fanout-wiring.test.ts`, `e2e/autopilot-fanout-postgres.test.ts`).
- [ ] New Postgres RLS test: restricted-role enqueue passes WITH scope, FAILS (negative control) without scope.
- [ ] Optional: `autopilot --verify-once` runs clean under `voltmind_restricted` pool URL.
- [ ] Docs this file's "interplay with hotfix" section is resolved in commit message.