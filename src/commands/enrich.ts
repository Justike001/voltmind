import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, isThinClient } from '../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';
import { operations, type OperationContext } from '../core/operations.ts';

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function printHelp(): void {
  console.log(`voltmind enrich - source-backed person/company signal enrichment

USAGE
  voltmind enrich preview --source-id <id> [--page-slug <slug>] [--limit N] [--external] [--json]
  voltmind enrich apply --source-id <id> [--page-slug <slug>] [--limit N] [--external] --confirm [--json]
`);
}

function printResult(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  const v = value as {
    detected?: unknown[];
    created?: string[];
    updated?: string[];
    timeline_added?: number;
    links_added?: number;
    skipped?: unknown[];
    warnings?: string[];
  };
  console.log(`Detected: ${v.detected?.length ?? 0}`);
  console.log(`Created: ${v.created?.length ?? 0}${v.created?.length ? ` (${v.created.join(', ')})` : ''}`);
  console.log(`Updated: ${v.updated?.length ?? 0}${v.updated?.length ? ` (${v.updated.join(', ')})` : ''}`);
  console.log(`Timeline entries: ${v.timeline_added ?? 0}`);
  console.log(`Links: ${v.links_added ?? 0}`);
  if (v.skipped?.length) console.log(`Skipped: ${v.skipped.length}`);
  if (v.warnings?.length) console.log(`Warnings: ${v.warnings.join('; ')}`);
}

export async function runEnrich(engine: BrainEngine | null, args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printHelp();
    return;
  }
  if (sub !== 'preview' && sub !== 'apply') {
    console.error(`Unknown enrich subcommand: ${sub}`);
    printHelp();
    process.exit(1);
  }

  const sourceId = flag(args, '--source-id');
  if (!sourceId) {
    console.error('Error: --source-id is required.');
    process.exit(1);
  }

  const json = hasFlag(args, '--json');
  const params = {
    source_id: sourceId,
    page_slug: flag(args, '--page-slug'),
    limit: Number(flag(args, '--limit') ?? 100),
    external: hasFlag(args, '--external'),
    ...(sub === 'apply' ? { confirm: hasFlag(args, '--confirm') } : {}),
  };

  const cfg = loadConfig();
  if (isThinClient(cfg)) {
    const tool = sub === 'preview' ? 'preview_signal_enrichment' : 'apply_signal_enrichment';
    const raw = await callRemoteTool(cfg!, tool, params, { timeoutMs: 60_000 });
    printResult(unpackToolResult(raw), json);
    return;
  }

  if (!engine) throw new Error('A local brain is required for enrich.');
  const op = operations.find(o => o.name === (sub === 'preview' ? 'preview_signal_enrichment' : 'apply_signal_enrichment'));
  if (!op) throw new Error('enrich operation missing (voltmind build issue)');
  const ctx: OperationContext = {
    engine,
    config: cfg ?? { engine: 'pglite' },
    logger: console,
    dryRun: sub === 'preview',
    remote: false,
    sourceId,
  };
  const result = await op.handler(ctx, params);
  printResult(result, json);
}
