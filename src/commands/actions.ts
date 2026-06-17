import type { BrainEngine } from '../core/engine.ts';
import {
  approveAction,
  getAction,
  listActionRuns,
  listActions,
  runAction,
  scanActions,
  updateActionStatus,
} from '../core/actions.ts';

function printHelp(): void {
  console.log(`voltmind actions - scan, review, and prepare agent-assisted actions

USAGE
  voltmind actions scan [--repo PATH]
  voltmind actions list [--status open] [--risk low|medium|high|restricted] [--due] [--limit N] [--json]
  voltmind actions get <slug> [--json]
  voltmind actions approve <slug> [--by NAME]
  voltmind actions run <slug> [--now] [--dry-run] [--prompt TEXT] [--json]
  voltmind actions runs <slug> [--json]
  voltmind actions complete|block|cancel <slug> [--note TEXT]

V1 prepares draft-only execution prompts. It does not send email, operate a
browser, or mutate external systems.`);
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function printActionResult(slug: string, result: Record<string, unknown>): void {
  const status = typeof result.status === 'string' ? result.status : '';
  const reason = typeof result.reason === 'string' ? result.reason : '';
  const prompt = typeof result.prompt === 'string' ? result.prompt : (result.run as Record<string, unknown> | null)?.prompt as string || '';

  switch (status) {
    case 'draft_only':
      console.log('Prepared action ' + slug + '.');
      console.log('');
      console.log(prompt);
      break;
    case 'dry_run':
      console.log('[DRY RUN] ' + slug);
      console.log('');
      console.log(prompt);
      break;
    case 'blocked':
      console.log('Blocked action ' + slug + ': ' + (reason || 'unknown reason'));
      break;
    case 'needs_approval':
      console.log('Action ' + slug + ' needs approval: ' + (reason || ''));
      console.log('Run `voltmind actions approve ' + slug + '` first.');
      break;
    case 'executed': {
      const outcome = result.outcome as Record<string, unknown> | undefined;
      const summary = typeof outcome?.summary === 'string' ? outcome.summary : 'Action executed.';
      console.log('Executed action ' + slug + ': ' + summary);
      const refs = Array.isArray(outcome?.artifactRefs) ? outcome.artifactRefs as string[] : [];
      if (refs.length > 0) {
        console.log('Artifacts:');
        for (const ref of refs) console.log('  - ' + ref);
      }
      break;
    }
    case 'failed': {
      const outcome = result.outcome as Record<string, unknown> | undefined;
      const errors = Array.isArray(outcome?.errors) ? outcome.errors as string[] : [];
      console.log('Failed action ' + slug);
      if (errors.length > 0) {
        console.log('Errors:');
        for (const err of errors) console.log('  - ' + err);
      }
      const stderrTruncated = typeof outcome?.stderrTruncated === 'string' ? outcome.stderrTruncated : '';
      if (stderrTruncated) {
        console.log('');
        console.log('stderr:');
        console.log(stderrTruncated);
      }
      break;
    }
    default:
      console.log(result.allowed ? 'Prepared action ' + slug + '.' : 'Blocked action ' + slug + ': ' + reason);
      console.log('');
      console.log(prompt);
  }
}

export async function runActions(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0] || 'list';
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    printHelp();
    return;
  }

  switch (sub) {
    case 'scan': {
      const result = await scanActions(engine, { repo: parseFlag(args, '--repo') });
      if (hasFlag(args, '--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`Scanned ${result.scanned} action file(s), indexed ${result.indexed}.`);
      return;
    }
    case 'list': {
      const actions = await listActions(engine, {
        status: parseFlag(args, '--status'),
        risk: parseFlag(args, '--risk'),
        dueOnly: hasFlag(args, '--due'),
        limit: Number(parseFlag(args, '--limit') || 50),
      });
      if (hasFlag(args, '--json')) {
        console.log(JSON.stringify(actions, null, 2));
        return;
      }
      if (actions.length === 0) {
        console.log('No actions found. Run `voltmind actions scan` first.');
        return;
      }
      for (const a of actions) {
        const due = a.due_at ? a.due_at.slice(0, 16).replace('T', ' ') : 'no due';
        const approval = a.approved_at ? 'approved' : (a.requires_approval || a.risk_level === 'medium' ? 'needs approval' : 'ready');
        console.log(`${a.slug}\t${a.status}\t${a.risk_level}\t${due}\t${approval}\t${a.title}`);
      }
      return;
    }
    case 'get': {
      const slug = args[1];
      if (!slug) throw new Error('Usage: voltmind actions get <slug>');
      const action = await getAction(engine, slug);
      if (!action) throw new Error(`Action not found: ${slug}`);
      console.log(JSON.stringify(action, null, 2));
      return;
    }
    case 'approve': {
      const slug = args[1];
      if (!slug) throw new Error('Usage: voltmind actions approve <slug>');
      const action = await approveAction(engine, slug, { approvedBy: parseFlag(args, '--by') || 'local-admin' });
      if (hasFlag(args, '--json')) console.log(JSON.stringify(action, null, 2));
      else console.log(`Approved ${slug}.`);
      return;
    }
    case 'run': {
      const slug = args[1];
      if (!slug) throw new Error('Usage: voltmind actions run <slug>');
      const result = await runAction(engine, slug, {
        now: hasFlag(args, '--now'),
        dryRun: hasFlag(args, '--dry-run'),
        userPrompt: parseFlag(args, '--prompt') || null,
      });
      if (hasFlag(args, '--json')) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(result.allowed ? `Prepared action ${slug}.` : `Blocked action ${slug}: ${result.reason}`);
      console.log('');
      console.log(result.run.prompt);
      return;
    }
    case 'runs': {
      const slug = args[1];
      if (!slug) throw new Error('Usage: voltmind actions runs <slug>');
      const runs = await listActionRuns(engine, slug);
      console.log(JSON.stringify(runs, null, 2));
      return;
    }
    case 'complete':
    case 'block':
    case 'cancel': {
      const slug = args[1];
      if (!slug) throw new Error(`Usage: voltmind actions ${sub} <slug>`);
      const status = sub === 'complete' ? 'done' : sub === 'block' ? 'blocked' : 'canceled';
      const action = await updateActionStatus(engine, slug, status, { note: parseFlag(args, '--note') });
      if (hasFlag(args, '--json')) console.log(JSON.stringify(action, null, 2));
      else console.log(`Set ${slug} to ${status}.`);
      return;
    }
    default:
      console.error(`Unknown actions subcommand: ${sub}`);
      printHelp();
      process.exit(2);
  }
}
