# VoltMind naming migration (v106)

Version 106 moves active runtime access to VoltMind names without making an
existing Supabase brain incompatible with an older VoltMind binary.

## What changes

| Legacy identifier | VoltMind runtime identifier | Compatibility during rollback window |
| --- | --- | --- |
| `gbrain_cycle_locks` | `voltmind_cycle_locks` | The old name is an updatable, `security_invoker` view over the renamed table. Old and new workers therefore contend for the same lock rows. |
| `gbrain_tool_use_id` | `voltmind_tool_use_id` | Both columns remain. A trigger backfills either name and rejects conflicting values. |
| `GBRAIN:RLS_EXEMPT` | `VOLTMIND:RLS_EXEMPT` | Doctor accepts both markers. New operator documentation uses the VoltMind marker. |

## Deployment procedure

1. Take a verified Supabase backup and stop Autopilot/workers that can acquire
   cycle or sync locks.
2. Deploy the binary containing v106.
3. Run `voltmind apply-migrations --yes` once, using the database owner or a
   role with the same DDL/RLS privileges as previous migrations.
4. Start workers and run `voltmind doctor`. Confirm schema version 106 and no
   lock-related warnings.

The migration refuses a split-brain state where both lock names are physical
tables. Resolve that manually rather than allowing two independent lock
domains.

After v106 is verified and all worker leases are stopped, the compatibility
bridge may be finalized as a one-way cleanup: drop the `gbrain_cycle_locks`
view, drop the `gbrain_tool_use_id` column and its sync trigger, and normalize
existing `GBRAIN:RLS_EXEMPT` comments to `VOLTMIND:RLS_EXEMPT`. This finalization
was completed on the configured Supabase brain after confirming zero active
leases. Keep Autopilot paused until the updated CLI binary is deployed.

## Rollback

For an application rollback, no database migration is required: stop the new
workers, deploy the previous binary, and start workers again. The legacy view
and the synchronized legacy ID column preserve its reads and writes.

Use a physical schema rollback only when permanently abandoning v106. Stop all
workers first, verify there are no unexpired lock rows, take another backup,
then execute this transaction as the database owner:

```sql
BEGIN;

LOCK TABLE public.voltmind_cycle_locks IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.subagent_tool_executions IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.voltmind_cycle_locks WHERE ttl_expires_at >= now()
  ) THEN
    RAISE EXCEPTION 'Refusing v106 rollback while a lock lease is still active';
  END IF;
END $$;

DROP VIEW IF EXISTS public.gbrain_cycle_locks;
ALTER TABLE public.voltmind_cycle_locks RENAME TO gbrain_cycle_locks;

DROP TRIGGER IF EXISTS sync_voltmind_tool_use_id_trg
  ON public.subagent_tool_executions;
DROP FUNCTION IF EXISTS public.sync_voltmind_tool_use_id();
ALTER TABLE public.subagent_tool_executions
  DROP COLUMN IF EXISTS voltmind_tool_use_id;

UPDATE config SET value = '105' WHERE key = 'version';
COMMIT;
```

Do not run the physical rollback merely to roll back the binary: it removes the
forward-compatible bridge and requires the configuration version reset shown
above before v106 can be applied again.
