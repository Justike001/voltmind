#!/usr/bin/env bun
/** Synthetic process benchmark: no private vault, model, database, or scheduler. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { schedulePacket, reviewScheduleQueue } from '../src/commands/action-schedule.ts';

const vault = mkdtempSync(join(tmpdir(), 'voltmind-schedule-bench-'));
const rounds = 12;
const processMs: number[] = [];
const handlerMs: number[] = [];
const receiptOnlyMs: number[] = [];
const reviewChoiceMs: number[] = [];
try {
  mkdirSync(join(vault, 'state/actions'), { recursive: true });
  writeFileSync(join(vault, 'state/actions/README.md'), '# Filing rules\n', 'utf8');
  writeFileSync(join(vault, 'state/actions/broken.md'), '---\nstatus: [\n---\n', 'utf8');
  for (let i = 0; i < 100; i++) {
    writeFileSync(join(vault, `state/actions/item-${i}.md`), `---\ntitle: Example ${i}\nstatus: open\npriority: medium\n---\n# Synthetic action\n`, 'utf8');
  }
  for (let i = 0; i < rounds; i++) {
    const slug = `state/actions/item-${i}`;
    const expected = schedulePacket(vault, slug).sha256;
    const start = performance.now();
    const result = spawnSync(process.execPath, [resolve('scripts/action-schedule.ts'), 'decide', slug,
      '--vault', vault, '--decision', i % 2 ? 'complete' : 'obsolete', '--expect', expected,
      '--source', 'User, benchmark', '--next'], { encoding: 'utf8', timeout: 30_000 });
    const elapsed = performance.now() - start;
    if (result.status !== 0) throw new Error(`Benchmark child failed: ${result.error?.message ?? result.stderr}`);
    const receipt = JSON.parse(result.stdout);
    if (!receipt.receipt.changed || !receipt.next || receipt.warnings.length !== 1) throw new Error('Invalid benchmark receipt');
    processMs.push(elapsed);
    handlerMs.push(receipt.elapsed_ms);
  }
  for (let i = rounds; i < rounds * 2; i++) {
    const slug = `state/actions/item-${i}`;
    const expected = schedulePacket(vault, slug).sha256;
    const start = performance.now();
    const result = spawnSync(process.execPath, [resolve('scripts/action-schedule.ts'), 'decide', slug,
      '--vault', vault, '--decision', 'complete', '--expect', expected,
      '--source', 'User, benchmark'], { encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0 || !JSON.parse(result.stdout).receipt.changed) throw new Error('Receipt-only benchmark failed');
    receiptOnlyMs.push(performance.now() - start);
  }
  let choiceStart = 0;
  let choices = 0;
  const review = await reviewScheduleQueue(vault, {
    question: async () => { choiceStart = performance.now(); return choices++ < rounds ? '1' : 'q'; },
    report: () => { reviewChoiceMs.push(performance.now() - choiceStart); },
  });
  if (review.changed.length !== rounds) throw new Error('Interactive review benchmark did not commit every decision');
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p: number) => Math.round(sorted[Math.ceil(p * sorted.length) - 1] * 100) / 100;
    return { p50_ms: at(0.5), p95_ms: at(0.95), max_ms: at(1) };
  };
  console.log(JSON.stringify({ fixture_actions: 100, rounds, with_next_process: stats(processMs), with_next_handler: stats(handlerMs),
    receipt_only_process: stats(receiptOnlyMs), review_choice: stats(reviewChoiceMs),
    includes: 'Bun process startup, one decision write, next-card queue scan with README and malformed sibling',
    excludes: 'agent reasoning, tool transport, raw evidence review, Desktop registration, remote sync' }, null, 2));
} finally {
  // Only the exact directory created by mkdtemp above; never the configured vault.
  rmSync(vault, { recursive: true, force: true });
}
