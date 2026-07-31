import type { BrainEngine } from '../core/engine.ts';
import { getProjectTrackingStatus, reconcileProjectTracking } from '../core/project-tracking-runtime.ts';

function parseSource(args: string[]): string | undefined {
  const idx = args.indexOf('--source-id');
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}

export async function runProjectTracking(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0] ?? 'status';
  const sourceId = parseSource(args);
  if (sub === '--help' || sub === '-h') {
    console.log(
      'voltmind projects tracking status --source-id ID\n' +
      'VOLTMIND_RUNTIME_ROLE=company-server voltmind projects tracking reconcile --source-id ID\n',
    );
    return;
  }
  if (sub !== 'status' && sub !== 'reconcile') {
    throw new Error(`Unknown projects tracking command '${sub}'. Expected status or reconcile.`);
  }
  if (!sourceId) {
    throw new Error('projects tracking requires an explicit --source-id; default source fallback is forbidden');
  }
  if (sub === 'status') {
    console.log(JSON.stringify({
      ...await getProjectTrackingStatus(engine, sourceId),
      runtime_role: process.env.VOLTMIND_RUNTIME_ROLE ?? 'client',
    }, null, 2));
    return;
  }

  if (process.env.VOLTMIND_RUNTIME_ROLE !== 'company-server') {
    throw new Error(
      'projects tracking reconcile is server-only; set VOLTMIND_RUNTIME_ROLE=company-server on the company-brain host',
    );
  }
  if (engine.kind !== 'postgres') {
    throw new Error('projects tracking reconcile requires the company-brain Postgres engine');
  }

  console.log(JSON.stringify(await reconcileProjectTracking(engine, sourceId), null, 2));
}
