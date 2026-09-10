/** Local Markdown interview fast path. Deliberately has no engine/runtime imports. */
import { readFileSync, readdirSync, realpathSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { safeLoad, safeDump } from 'js-yaml';

type Fields = Record<string, any>;
export interface ScheduleDecision {
  slug: string;
  expected_sha256: string;
  decision: 'update' | 'reminder' | 'obsolete' | 'skip';
  source: string;
  note?: string;
  run_at?: string;
  timezone?: string;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function confined(root: string, path: string): string {
  const actual = realpathSync(path);
  const rel = relative(root, actual);
  if (rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel)) {
    throw new Error('Path escapes the selected vault');
  }
  return actual;
}
function actionPath(root: string, slug: string): string {
  if (!/^state\/actions\/[a-zA-Z0-9_-]+$/.test(slug)) throw new Error('Expected state/actions/<slug>');
  return confined(root, resolve(root, slug + '.md'));
}
function readAction(root: string, slug: string) {
  const path = actionPath(root, slug);
  const raw = readFileSync(path, 'utf8');
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) throw new Error(`Missing frontmatter: ${slug}`);
  const fields = safeLoad(match[1], { schema: undefined }) as Fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error(`Invalid frontmatter: ${slug}`);
  if (fields.automation != null && (typeof fields.automation !== 'object' || Array.isArray(fields.automation))) throw new Error(`Invalid automation: ${slug}`);
  return { path, raw, fields, body: raw.slice(match[0].length), sha256: hash(raw) };
}
function candidate(f: Fields): boolean {
  return !f.archived && (f.status === 'open' || (f.status === 'on_schedule' && !f.automation?.desktop_automation_id))
    && f.automation?.interview_status !== 'reminder_only';
}
export function scheduleQueue(vault: string, exclude: string[] = []) {
  const root = realpathSync(vault);
  let names: string[];
  try { names = readdirSync(confined(root, join(root, 'state/actions'))); }
  catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const due = (value: unknown) => { const n = Date.parse(String(value ?? '')); return Number.isFinite(n) ? n : Infinity; };
  return names.filter(n => /^[a-zA-Z0-9_-]+\.md$/.test(n)).map(n => {
    const slug = 'state/actions/' + n.slice(0, -3);
    const a = readAction(root, slug);
    return { slug, sha256: a.sha256, title: a.fields.title, status: a.fields.status,
      due: a.fields.due ?? a.fields.due_at, priority: a.fields.priority, fields: a.fields };
  }).filter(a => candidate(a.fields) && !exclude.includes(a.slug))
    .sort((a, b) => (due(a.due) - due(b.due) || (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3) || a.slug.localeCompare(b.slug)))
    .map(({ fields, ...summary }) => summary);
}

export function schedulePacket(vault: string, slug: string) {
  const root = realpathSync(vault);
  const a = readAction(root, slug);
  // Return full canonical content so evidence interpretation remains with the agent.
  return { slug, sha256: a.sha256, fields: a.fields, markdown: a.raw };
}

export function applyScheduleDecision(vault: string, input: ScheduleDecision, dryRun = false) {
  const root = realpathSync(vault);
  if (!['update', 'reminder', 'obsolete', 'skip'].includes(input.decision)) throw new Error('Unknown decision');
  const path = actionPath(root, input.slug);
  const lock = path + '.schedule.lock';
  const fd = openSync(lock, 'wx');
  let temp: string | undefined;
  try {
    const a = readAction(root, input.slug);
    if (a.sha256 !== input.expected_sha256) throw new Error('Action changed; read it again before applying the decision');
    if (input.decision === 'skip') return { slug: input.slug, status: 'skipped', changed: false, sha256: a.sha256 };
    if (!candidate(a.fields)) throw new Error('Action is not an interview candidate');
    if (!input.source?.trim() || /[\r\n\]]/.test(input.source)) throw new Error('A single-line user confirmation source is required');
    if (a.fields.automation?.desktop_automation_id) throw new Error('Reconcile the existing Desktop automation before changing this action');
    const f = a.fields;
    const automation = f.automation ??= {};
    if (input.decision === 'update') {
      if (!input.note?.trim()) throw new Error('update requires the current status in note');
      if (!input.run_at || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(input.run_at)
        || !Number.isFinite(Date.parse(input.run_at)) || Date.parse(input.run_at) <= Date.now()) throw new Error('run_at must be a future ISO timestamp with offset');
      if (!input.timezone) throw new Error('timezone is required');
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: input.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(input.run_at));
      const part = (name: string) => parts.find(p => p.type === name)?.value;
      if (`${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}` !== input.run_at.slice(0, 19)) throw new Error('run_at offset does not match timezone');
      f.status = 'open';
      automation.run_at = input.run_at;
      automation.timezone = input.timezone;
      automation.interview_status = 'schedule_requested';
      // Choosing a time does not approve an execution contract or register a task.
    } else {
      f.status = input.decision === 'obsolete' ? 'canceled' : 'open';
      automation.eligible = false;
      automation.mode = 'manual';
      automation.interview_status = input.decision === 'obsolete' ? 'obsolete' : 'reminder_only';
      delete automation.run_at;
      delete automation.schedule;
      delete automation.idempotency_key;
    }
    f.updated = new Date().toISOString().slice(0, 10);
    const note = (input.note ?? '').replace(/\r?\n/g, ' ');
    const body = a.body.replace(/\r\n/g, '\n') + `\n- ${new Date().toISOString()} | Schedule decision: ${input.decision}${note ? ' — ' + note : ''} [Source: ${input.source}]\n`;
    const content = '---\n' + safeDump(f, { noRefs: true, lineWidth: -1 }) + '---\n' + body;
    if (!dryRun) {
      temp = path + '.' + randomUUID() + '.tmp';
      writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
      if (hash(readFileSync(path, 'utf8')) !== a.sha256) throw new Error('Action changed during write; retry after reading it again');
      renameSync(temp, path);
      temp = undefined;
    }
    return { slug: input.slug, status: f.status, changed: !dryRun, dry_run: dryRun,
      sha256: dryRun ? a.sha256 : hash(content), remote_sync: 'deferred',
      next_step: input.decision === 'update' ? 'confirm_contract_and_register_with_desktop_tool' : 'continue_queue',
      ...(dryRun ? { markdown: content } : {}) };
  } finally {
    if (temp) unlinkSync(temp);
    closeSync(fd);
    unlinkSync(lock);
  }
}

export async function runActionSchedule(args: string[]): Promise<void> {
  if (!args.length || args.some(a => ['help', '--help', '-h'].includes(a))) {
    console.log(`voltmind actions schedule — local Markdown, no database or model calls
  queue --vault PATH [--exclude SLUG,SLUG]
  show SLUG --vault PATH
  decide --file decision.json --vault PATH [--dry-run] [--exclude SLUG,SLUG]

All results are JSON. --vault defaults to VOLTMIND_LOCAL_BRAIN_VAULT.
Decision JSON: {slug, expected_sha256, decision, source, note?, run_at?, timezone?}
Decisions: update, reminder, obsolete, skip. update saves a requested time;
the agent must confirm the contract and use the Desktop automation tool.
decide returns the next queue item. Carry skipped slugs with --exclude.
Choose the exact source repository as --vault; this command never guesses a source.`);
    return;
  }
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const allowed = new Set(['--vault', '--file', '--exclude', '--dry-run', '--json']);
  for (const arg of args) if (arg.startsWith('--') && !allowed.has(arg)) throw new Error(`Unknown option: ${arg}`);
  const vault = value('--vault') ?? process.env.VOLTMIND_LOCAL_BRAIN_VAULT;
  if (!vault) throw new Error('Set VOLTMIND_LOCAL_BRAIN_VAULT or pass --vault (exact source repository)');
  const exclude = (value('--exclude') ?? '').split(',').filter(Boolean);
  let result: unknown;
  if (args[0] === 'queue') result = scheduleQueue(vault, exclude);
  else if (args[0] === 'show') result = schedulePacket(vault, args[1]);
  else if (args[0] === 'decide') {
    const file = value('--file');
    if (!file) throw new Error('decide requires --file decision.json');
    const input = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as ScheduleDecision;
    const receipt = applyScheduleDecision(vault, input, args.includes('--dry-run'));
    const queue = scheduleQueue(vault, [...exclude, input.slug]);
    result = { receipt, next: queue[0] ?? null, remaining: queue.length };
  } else throw new Error('Expected queue, show, or decide');
  console.log(JSON.stringify(result, null, 2));
}
