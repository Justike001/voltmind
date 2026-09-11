/** Local Markdown interview fast path. Deliberately has no engine/runtime imports. */
import { readFileSync, readdirSync, realpathSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { safeLoad, safeDump } from 'js-yaml';

type Fields = Record<string, any>;
export interface ScheduleDecision {
  slug: string;
  expected_sha256: string;
  decision: 'update' | 'reminder' | 'obsolete' | 'complete' | 'skip';
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
  return !f.archived && !f.automation?.desktop_automation_id && ['open', 'on_schedule'].includes(f.status)
    && f.automation?.interview_status !== 'reminder_only';
}
export function scanScheduleQueue(vault: string, exclude: string[] = []) {
  const root = realpathSync(vault);
  const warnings: { slug: string; code: string }[] = [];
  let names: string[];
  try { names = readdirSync(confined(root, join(root, 'state/actions'))); }
  catch (e: any) { if (e.code === 'ENOENT') return { items: [], warnings }; throw e; }
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const due = (value: unknown) => { const n = Date.parse(String(value ?? '')); return Number.isFinite(n) ? n : Infinity; };
  const items = names.filter(n => /^[a-zA-Z0-9_-]+\.md$/.test(n) && !/^(readme|index)\.md$/i.test(n)).flatMap(n => {
    const slug = 'state/actions/' + n.slice(0, -3);
    if (exclude.includes(slug)) return [];
    try {
      const a = readAction(root, slug);
      if (!candidate(a.fields) || (a.fields.type && a.fields.type !== 'action')) return [];
      return [{ slug, sha256: a.sha256, title: a.fields.title, status: a.fields.status,
        due: a.fields.due ?? a.fields.due_at, priority: a.fields.priority,
        objective: a.fields.agent_contract?.objective ?? null }];
    } catch {
      // A bad sibling must not prevent processing valid actions or hide a committed receipt.
      // Do not include filesystem error messages: they may expose private absolute paths.
      warnings.push({ slug, code: 'unreadable_action' });
      return [];
    }
  })
    .sort((a, b) => (due(a.due) - due(b.due) || (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3) || a.slug.localeCompare(b.slug)))
  return { items, warnings };
}

export function scheduleQueue(vault: string, exclude: string[] = []) {
  return scanScheduleQueue(vault, exclude).items;
}

export function nextScheduleCard(vault: string, exclude: string[] = []) {
  const { items, warnings } = scanScheduleQueue(vault, exclude);
  return { next: items[0] ?? null, remaining: items.length, warnings, evidence_status: 'not_loaded' };
}

export function schedulePacket(vault: string, slug: string) {
  const root = realpathSync(vault);
  const a = readAction(root, slug);
  // Return full canonical content so evidence interpretation remains with the agent.
  return { slug, sha256: a.sha256, fields: a.fields, markdown: a.raw };
}

export function applyScheduleDecision(vault: string, input: ScheduleDecision, dryRun = false) {
  const root = realpathSync(vault);
  if (!input || !['update', 'reminder', 'obsolete', 'complete', 'skip'].includes(input.decision)) throw new Error('Unknown decision');
  if (typeof input.expected_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.expected_sha256)) throw new Error('expected_sha256 from the action card or show is required');
  for (const field of ['source', 'note', 'run_at', 'timezone'] as const) {
    if (input[field] !== undefined && typeof input[field] !== 'string') throw new Error(`${field} must be a string`);
  }
  const requestHash = hash(JSON.stringify([input.slug, input.expected_sha256, input.decision, input.source, input.note, input.run_at, input.timezone]));
  const path = actionPath(root, input.slug);
  const lock = path + '.schedule.lock';
  const fd = openSync(lock, 'wx');
  let temp: string | undefined;
  try {
    const a = readAction(root, input.slug);
    if (a.fields.schedule_decision?.request_sha256 === requestHash) {
      return { slug: input.slug, status: a.fields.status, changed: false, replayed: true,
        sha256: a.sha256, remote_sync: 'deferred', next_step: 'already_applied' };
    }
    if (a.sha256 !== input.expected_sha256) throw new Error('Action changed; read it again before applying the decision');
    if (input.decision === 'skip') return { slug: input.slug, status: 'skipped', changed: false, sha256: a.sha256 };
    if (!input.source?.trim() || /[\r\n\]]/.test(input.source)) throw new Error('A single-line user confirmation source is required');
    if (a.fields.automation?.desktop_automation_id) throw new Error('Reconcile the existing Desktop automation before changing this action');
    // An explicit completion/closure also applies to manual reminders and blocked actions.
    const terminalDecision = input.decision === 'complete' || input.decision === 'obsolete';
    const closable = !a.fields.archived && ['open', 'blocked', 'on_schedule'].includes(a.fields.status);
    if (!(terminalDecision ? closable : candidate(a.fields))) throw new Error('Action is not an interview candidate');
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
      f.status = input.decision === 'obsolete' ? 'canceled' : input.decision === 'complete' ? 'done' : 'open';
      automation.eligible = false;
      automation.mode = 'manual';
      automation.interview_status = input.decision === 'obsolete' ? 'obsolete' : input.decision === 'complete' ? 'completed' : 'reminder_only';
      delete automation.run_at;
      delete automation.schedule;
      delete automation.idempotency_key;
    }
    f.updated = new Date().toISOString().slice(0, 10);
    f.schedule_decision = { request_sha256: requestHash, decision: input.decision, applied_at: new Date().toISOString() };
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

/** Direct terminal interaction avoids a model/tool round trip for every lifecycle choice. */
export async function reviewScheduleQueue(vault: string, io: {
  question: (prompt: string) => Promise<string>;
  report: (text: string) => void;
}, exclude: string[] = []) {
  const { items, warnings } = scanScheduleQueue(vault, exclude);
  const changed: string[] = [];
  const executionRequested: string[] = [];
  const skipped: string[] = [];
  const choices: Record<string, ScheduleDecision['decision']> = { '1': 'complete', '2': 'obsolete', '3': 'reminder', '4': 'skip' };
  for (const item of items) {
    while (true) {
      const answer = (await io.question(`${item.title ?? item.slug}\n${item.slug}\n1 Complete | 2 Obsolete | 3 Manual reminder | 4 Skip | 5 Arrange with agent | q Quit\n> `)).trim();
      if (answer === 'q') return { changed, execution_requested: executionRequested, skipped, warnings, remote_sync: 'deferred' };
      if (answer === '5') {
        executionRequested.push(item.slug);
        io.report('Execution preparation requested; continue this action with the agent. No task registered.');
        break;
      }
      const choice = choices[answer];
      if (!choice) { io.report('Choose 1-5 or q.'); continue; }
      try {
        const receipt = applyScheduleDecision(vault, { slug: item.slug, expected_sha256: item.sha256,
          decision: choice, source: `User via local review, ${new Date().toISOString()}` });
        if (receipt.changed) changed.push(item.slug);
        if (choice === 'skip') skipped.push(item.slug);
        io.report(`${receipt.status}: ${item.slug}`);
      } catch (error) {
        // Do not refresh the SHA and auto-apply a decision to an unseen revision.
        warnings.push({ slug: item.slug, code: 'decision_failed' });
        io.report(error instanceof Error ? error.message : String(error));
      }
      break;
    }
  }
  return { changed, execution_requested: executionRequested, skipped, warnings, remote_sync: 'deferred' };
}

export async function runActionSchedule(args: string[]): Promise<void> {
  const started = performance.now();
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    vault: { type: 'string' }, file: { type: 'string' }, exclude: { type: 'string' },
    decision: { type: 'string' }, expect: { type: 'string' }, source: { type: 'string' },
    note: { type: 'string' }, 'run-at': { type: 'string' }, timezone: { type: 'string' },
    next: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (!args.length || values.help || positionals[0] === 'help') {
    console.log(`voltmind actions schedule — local Markdown, no database or model calls
  queue --vault PATH [--exclude SLUG,SLUG]
  next --vault PATH [--exclude SLUG,SLUG]
  review --vault PATH                 Interactive terminal lifecycle review (no model)
  show SLUG --vault PATH
  decide SLUG --decision complete|obsolete|reminder|skip|update --expect SHA256
    --source "User, YYYY-MM-DD" [--note TEXT] [--run-at ISO --timezone IANA]
    [--vault PATH] [--next] [--exclude SLUG,SLUG] [--dry-run]
  decide --file decision.json [--vault PATH] [--next] [--dry-run]

Results are JSON except interactive review prompts. --vault defaults to VOLTMIND_LOCAL_BRAIN_VAULT.
Decision JSON: {slug, expected_sha256, decision, source, note?, run_at?, timezone?}
Decisions: update, reminder, obsolete, complete, skip. update saves a requested time;
the agent must confirm the contract and use the Desktop automation tool.
decide returns a receipt without scanning the queue. --next adds a compact next card.
next cards are for lifecycle triage; raw evidence is read only when planning execution.
Exact decision retries return replayed:true without a second write.
Choose the exact source repository as --vault; this command never guesses a source.`);
    return;
  }
  const vault = values.vault ?? process.env.VOLTMIND_LOCAL_BRAIN_VAULT;
  if (!vault) throw new Error('Set VOLTMIND_LOCAL_BRAIN_VAULT or pass --vault (exact source repository)');
  const exclude = (values.exclude ?? '').split(',').filter(Boolean);
  let result: unknown;
  if (positionals[0] === 'queue') result = { ...scanScheduleQueue(vault, exclude), elapsed_ms: performance.now() - started };
  else if (positionals[0] === 'next') result = { ...nextScheduleCard(vault, exclude), elapsed_ms: performance.now() - started };
  else if (positionals[0] === 'show') result = schedulePacket(vault, positionals[1]);
  else if (positionals[0] === 'review') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('review requires an interactive terminal; agents should use next/decide');
    if (values['dry-run'] || values.file || values.decision) throw new Error('review takes interactive choices only');
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { result = await reviewScheduleQueue(vault, { question: prompt => rl.question(prompt), report: message => console.log(message) }, exclude); }
    finally { rl.close(); }
  }
  else if (positionals[0] === 'decide') {
    if (values.file && (positionals[1] || ['decision', 'expect', 'source', 'note', 'run-at', 'timezone'].some(k => values[k as keyof typeof values] !== undefined))) {
      throw new Error('Use either --file or direct decision arguments, not both');
    }
    const input = values.file
      ? JSON.parse(readFileSync(values.file, 'utf8').replace(/^\uFEFF/, '')) as ScheduleDecision
      : { slug: positionals[1], expected_sha256: values.expect!, decision: values.decision as ScheduleDecision['decision'],
        source: values.source!, note: values.note, run_at: values['run-at'], timezone: values.timezone };
    const receipt = applyScheduleDecision(vault, input, values['dry-run']);
    let continuation: unknown = {};
    if (values.next && !values['dry-run']) {
      try { continuation = nextScheduleCard(vault, [...exclude, input.slug]); }
      catch { continuation = { next: null, remaining: null, warnings: [{ code: 'next_unavailable' }] }; }
    }
    // Never let a derived queue failure turn an already committed decision into an error.
    result = { receipt, ...continuation as object, elapsed_ms: performance.now() - started };
  } else throw new Error('Expected queue, next, show, decide, or review');
  console.log(JSON.stringify(result, null, 2));
}
