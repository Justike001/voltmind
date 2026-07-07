import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, isThinClient } from '../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';
import {
  applyCandidate,
  getCandidate,
  listCandidates,
  previewCandidateApply,
  rejectCandidate,
} from '../core/candidates.ts';

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function printHelp(): void {
  console.log(`voltmind candidates - review proposed enrichment before explicit apply

USAGE
  voltmind candidates list [--status pending|accepted|rejected|all] [--source-id id] [--limit N] [--json]
  voltmind candidates get <candidate-id> [--json]
  voltmind candidates preview <candidate-id> [--json]
  voltmind candidates apply <candidate-id> --source-id <id> --citation <text> --confirm [--json]
  voltmind candidates reject <candidate-id> [--json]
`);
}

function printHuman(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function runCandidates(engine: BrainEngine | null, args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printHelp();
    return;
  }
  const json = hasFlag(args, '--json');
  const cfg = loadConfig();
  const thin = isThinClient(cfg);

  if (sub === 'list') {
    const status = flag(args, '--status') ?? 'pending';
    const limit = parseInt(flag(args, '--limit') ?? '20', 10) || 20;
    const sourceId = flag(args, '--source-id');
    let result: unknown;
    if (thin) {
      throw new Error('Remote candidates list is CLI-only in this MVP; use MCP preview/apply/reject by candidate id.');
    }
    if (!engine) throw new Error('A local brain is required for candidates list.');
    result = { candidates: await listCandidates(engine, { status, sourceId, limit }) };
    if (json) printHuman(result);
    else {
      const rows = (result as { candidates: Array<{ candidate_id: number; page_slug: string; status: string; claim: string }> }).candidates;
      if (rows.length === 0) console.log('No candidates found.');
      for (const r of rows) console.log(`#${r.candidate_id} ${r.status} ${r.page_slug}: ${r.claim}`);
    }
    return;
  }

  const id = parseInt(args[1] ?? '', 10);
  if (!Number.isFinite(id)) {
    console.error(`Error: candidate id required. Usage: voltmind candidates ${sub} <candidate-id>`);
    process.exit(1);
  }

  if (sub === 'get') {
    if (thin) throw new Error('Remote candidates get is CLI-only in this MVP; use preview by candidate id.');
    if (!engine) throw new Error('A local brain is required for candidates get.');
    printHuman(await getCandidate(engine, id));
    return;
  }

  if (sub === 'preview') {
    let result: unknown;
    if (thin) {
      const raw = await callRemoteTool(cfg!, 'preview_candidate_apply', { candidate_id: id }, { timeoutMs: 30_000 });
      result = unpackToolResult(raw);
    } else {
      if (!engine) throw new Error('A local brain is required for candidates preview.');
      result = await previewCandidateApply(engine, id);
    }
    printHuman(result);
    return;
  }

  if (sub === 'apply') {
    const sourceId = flag(args, '--source-id') ?? '';
    const citation = flag(args, '--citation') ?? '';
    const confirm = hasFlag(args, '--confirm');
    let result: unknown;
    if (thin) {
      const raw = await callRemoteTool(cfg!, 'apply_candidate', {
        candidate_id: id,
        source_id: sourceId,
        citation,
        confirm,
      }, { timeoutMs: 30_000 });
      result = unpackToolResult(raw);
    } else {
      if (!engine) throw new Error('A local brain is required for candidates apply.');
      result = await applyCandidate(engine, { candidateId: id, sourceId, citation, confirm });
    }
    printHuman(result);
    return;
  }

  if (sub === 'reject') {
    let result: unknown;
    if (thin) {
      const raw = await callRemoteTool(cfg!, 'reject_candidate', { candidate_id: id }, { timeoutMs: 30_000 });
      result = unpackToolResult(raw);
    } else {
      if (!engine) throw new Error('A local brain is required for candidates reject.');
      result = await rejectCandidate(engine, id);
    }
    printHuman(result);
    return;
  }

  console.error(`Unknown candidates subcommand: ${sub}`);
  printHelp();
  process.exit(1);
}
