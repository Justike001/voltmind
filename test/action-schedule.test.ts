import { test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scheduleQueue, scanScheduleQueue, nextScheduleCard, runActionSchedule, reviewScheduleQueue, schedulePacket, applyScheduleDecision, type ScheduleDecision } from '../src/commands/action-schedule.ts';

let vault: string;
const slug = 'state/actions/example';
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'action-schedule-test-'));
  mkdirSync(join(vault, 'state/actions'), { recursive: true });
  writeFileSync(join(vault, slug + '.md'), '---\ntitle: 测试行动\nstatus: open\npriority: high\ncustom: keep\nautomation:\n  requires_approval: true\n---\n# 原始内容\n', 'utf8');
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));
function decision(kind: ScheduleDecision['decision']): ScheduleDecision {
  return { slug, expected_sha256: schedulePacket(vault, slug).sha256, decision: kind, source: 'User, 2026-09-10' };
}
test('reminder preserves content and approval, stays open, leaves the interview queue', () => {
  applyScheduleDecision(vault, decision('reminder'));
  const packet = schedulePacket(vault, slug);
  expect(packet.fields.status).toBe('open');
  expect(packet.fields.custom).toBe('keep');
  expect(packet.fields.automation.requires_approval).toBe(true);
  expect(packet.markdown).toContain('# 原始内容');
  expect(packet.markdown).toContain('[Source: User, 2026-09-10]');
  expect(scheduleQueue(vault)).toEqual([]);
});
test('skip and dry run leave bytes unchanged', () => {
  const before = schedulePacket(vault, slug).markdown;
  applyScheduleDecision(vault, decision('skip'));
  applyScheduleDecision(vault, decision('obsolete'), true);
  expect(schedulePacket(vault, slug).markdown).toBe(before);
  expect(scheduleQueue(vault, [slug])).toEqual([]);
});
test('stale decisions cannot overwrite newer content; lock is released', () => {
  const old = decision('obsolete');
  writeFileSync(join(vault, slug + '.md'), schedulePacket(vault, slug).markdown + '\nNew evidence\n', 'utf8');
  expect(() => applyScheduleDecision(vault, old)).toThrow('changed');
  applyScheduleDecision(vault, decision('obsolete'));
  expect(schedulePacket(vault, slug).fields.status).toBe('canceled');
});
test('update validates future time and timezone without approving or registering', () => {
  const d = { ...decision('update'), note: '等待审核', run_at: '2099-10-10T10:00:00+08:00', timezone: 'Asia/Shanghai' };
  applyScheduleDecision(vault, d);
  const packet = schedulePacket(vault, slug);
  expect(packet.fields.status).toBe('open');
  expect(packet.fields.automation.requires_approval).toBe(true);
  expect(packet.fields.automation.desktop_automation_id).toBeUndefined();
  expect(() => applyScheduleDecision(vault, { ...d, expected_sha256: packet.sha256, run_at: '2000-01-01T10:00:00+08:00' })).toThrow('future');
  expect(() => applyScheduleDecision(vault, { ...d, expected_sha256: packet.sha256, timezone: 'UTC' })).toThrow('offset');
});
test('path traversal and active desktop identities fail closed', () => {
  expect(() => schedulePacket(vault, '../outside')).toThrow('slug');
  const path = join(vault, slug + '.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace('requires_approval: true', 'desktop_automation_id: existing'));
  expect(() => applyScheduleDecision(vault, decision('obsolete'))).toThrow('Desktop');
});

test('README and malformed siblings do not block valid actions', () => {
  writeFileSync(join(vault, 'state/actions/README.md'), '# Action filing rules\n', 'utf8');
  writeFileSync(join(vault, 'state/actions/broken.md'), '---\nstatus: [broken\n---\n', 'utf8');
  const scan = scanScheduleQueue(vault);
  expect(scan.items.map(a => a.slug)).toEqual([slug]);
  expect(scan.warnings).toEqual([{ slug: 'state/actions/broken', code: 'unreadable_action' }]);
});

test('next cards do not load raw sources or modify action bytes', () => {
  const before = schedulePacket(vault, slug).markdown;
  const card = nextScheduleCard(vault);
  expect(card.next?.slug).toBe(slug);
  expect(card.next?.sha256).toBe(schedulePacket(vault, slug).sha256);
  expect(card.evidence_status).toBe('not_loaded');
  expect(schedulePacket(vault, slug).markdown).toBe(before);
});

test('complete disables execution, preserves approvals, and records user provenance', () => {
  applyScheduleDecision(vault, { ...decision('complete'), note: '用户确认已完成' });
  const packet = schedulePacket(vault, slug);
  expect(packet.fields.status).toBe('done');
  expect(packet.fields.automation.eligible).toBe(false);
  expect(packet.fields.automation.requires_approval).toBe(true);
  expect(packet.markdown).toContain('用户确认已完成');
  expect(scheduleQueue(vault)).toEqual([]);
});

test('exact retry acknowledges the earlier write without duplicating its citation', () => {
  const d = decision('obsolete');
  applyScheduleDecision(vault, d);
  const before = schedulePacket(vault, slug).markdown;
  const retry = applyScheduleDecision(vault, d);
  expect(retry.replayed).toBe(true);
  expect(retry.changed).toBe(false);
  expect(schedulePacket(vault, slug).markdown).toBe(before);
  expect(() => applyScheduleDecision(vault, { ...d, decision: 'complete' })).toThrow('changed');
});

test('a manual reminder can later be completed explicitly', () => {
  applyScheduleDecision(vault, decision('reminder'));
  applyScheduleDecision(vault, decision('complete'));
  expect(schedulePacket(vault, slug).fields.status).toBe('done');
});

async function cli(args: string[]) {
  const output = spyOn(console, 'log').mockImplementation(() => {});
  try {
    await runActionSchedule([...args, '--vault', vault]);
    return JSON.parse(String(output.mock.calls[0][0]));
  } finally { output.mockRestore(); }
}

test('one direct command commits a decision and returns the next card despite bad siblings', async () => {
  writeFileSync(join(vault, 'state/actions/README.md'), '# No frontmatter', 'utf8');
  writeFileSync(join(vault, 'state/actions/broken.md'), '# Invalid action', 'utf8');
  writeFileSync(join(vault, 'state/actions/next.md'), '---\nstatus: open\ntitle: Next action\n---\n', 'utf8');
  const d = decision('obsolete');
  const result = await cli(['decide', slug, '--decision', d.decision, '--expect', d.expected_sha256, '--source', d.source, '--next']);
  expect(result.receipt.status).toBe('canceled');
  expect(result.receipt.changed).toBe(true);
  expect(result.next.slug).toBe('state/actions/next');
  expect(result.warnings).toHaveLength(1);
  expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
  expect(schedulePacket(vault, slug).fields.status).toBe('canceled');
});

test('default decision only returns receipt; dry-run does not advance to next', async () => {
  const d = decision('complete');
  const args = ['decide', slug, '--decision', d.decision, '--expect', d.expected_sha256, '--source', d.source];
  const preview = await cli([...args, '--dry-run', '--next']);
  expect(preview.receipt.changed).toBe(false);
  expect(preview.next).toBeUndefined();
  const result = await cli(args);
  expect(result.receipt.status).toBe('done');
  expect(result.next).toBeUndefined();
});

test('strict flag parsing refuses missing values before writing', async () => {
  const before = schedulePacket(vault, slug).markdown;
  await expect(cli(['decide', slug, '--decision', 'obsolete', '--expect'])).rejects.toThrow();
  expect(schedulePacket(vault, slug).markdown).toBe(before);
});

test('local review applies only the selected item and returns agent handoffs without registering', async () => {
  writeFileSync(join(vault, 'state/actions/next.md'), '---\nstatus: open\ntitle: Next action\npriority: low\n---\n', 'utf8');
  const answers = ['invalid', '1', '5'];
  const result = await reviewScheduleQueue(vault, { question: async () => answers.shift()!, report: () => {} });
  expect(result.changed).toEqual([slug]);
  expect(result.execution_requested).toEqual(['state/actions/next']);
  expect(schedulePacket(vault, slug).fields.status).toBe('done');
  expect(schedulePacket(vault, 'state/actions/next').fields.status).toBe('open');
  expect(schedulePacket(vault, 'state/actions/next').fields.automation).toBeUndefined();
});

test('review quit and stale choices do not mutate unseen action content', async () => {
  const before = schedulePacket(vault, slug).markdown;
  await reviewScheduleQueue(vault, { question: async () => 'q', report: () => {} });
  expect(schedulePacket(vault, slug).markdown).toBe(before);
  const result = await reviewScheduleQueue(vault, { question: async () => {
    writeFileSync(join(vault, slug + '.md'), before + '\nConcurrent evidence\n', 'utf8');
    return '2';
  }, report: () => {} });
  expect(result.changed).toEqual([]);
  expect(result.warnings[0].code).toBe('decision_failed');
  expect(schedulePacket(vault, slug).fields.status).toBe('open');
});
