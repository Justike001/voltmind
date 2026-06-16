import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildActionPrompt,
  evaluateActionPolicy,
  listActions,
  getActionPlan,
  saveActionPlan,
  scanActions,
  type ActionRecord,
} from '../src/core/actions.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

function action(overrides: Partial<ActionRecord> = {}): ActionRecord {
  return {
    source_id: 'default',
    slug: 'state/actions/action-2026-06-12-example',
    title: 'Example action',
    status: 'open',
    priority: 'medium',
    due_at: new Date(Date.now() - 60_000).toISOString(),
    eligible: true,
    mode: 'agent_assisted',
    runtime: 'codex',
    trigger: 'due_time',
    risk_level: 'low',
    requires_confirmation: true,
    requires_approval: false,
    max_autonomy: 'draft_only',
    approved_at: null,
    approved_by: null,
    last_run_at: null,
    last_run_status: null,
    outcome: null,
    next_step: null,
    agent_contract: {
      objective: 'Prepare a browser plan',
      context_refs: ['projects/example'],
      success_criteria: ['Draft is reviewable'],
    },
    automation: {},
    allowed_tools: ['browser'],
    blocked_tools: ['email_send'],
    user_prompt: null,
    file_path: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('VoltMind actions policy', () => {
  test('allows low-risk draft-only agent-assisted action', () => {
    expect(evaluateActionPolicy(action())).toEqual({ allowed: true });
  });

  test('requires approval for medium risk', () => {
    expect(evaluateActionPolicy(action({ risk_level: 'medium' })).allowed).toBe(false);
    expect(evaluateActionPolicy(action({ risk_level: 'medium', approved_at: new Date().toISOString() }))).toEqual({ allowed: true });
  });

  test('blocks high and restricted actions', () => {
    expect(evaluateActionPolicy(action({ risk_level: 'high' })).allowed).toBe(false);
    expect(evaluateActionPolicy(action({ risk_level: 'restricted' })).allowed).toBe(false);
  });

  test('does not run future actions unless forced', () => {
    const future = action({ due_at: new Date(Date.now() + 60_000).toISOString() });
    expect(evaluateActionPolicy(future).allowed).toBe(false);
    expect(evaluateActionPolicy(future, { now: true })).toEqual({ allowed: true });
  });
});

describe('VoltMind actions prompt', () => {
  test('includes the v1 no-side-effect boundary', () => {
    const prompt = buildActionPrompt(action(), 'Prefer a short draft.');
    expect(prompt).toContain('Prepare a browser plan');
    expect(prompt).toContain('projects/example');
    expect(prompt).toContain('Prefer a short draft.');
    expect(prompt).toContain('Do not send email, operate a browser, mutate external systems');
  });
});

describe('VoltMind actions DB index', () => {
  test('scan materializes state/actions markdown into action_index and prunes stale rows', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'voltmind-actions-'));
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      const actionsDir = join(repo, 'state', 'actions');
      await mkdir(actionsDir, { recursive: true });
      const actionPath = join(actionsDir, 'email-draft.md');
      await writeFile(actionPath, [
        '---',
        'title: Draft follow-up email',
        'status: open',
        'priority: medium',
        'due: 2026-06-15T17:30',
        'automation:',
        '  eligible: true',
        '  mode: agent_assisted',
        '  runtime: codex',
        '  trigger: due_time',
        '  risk_level: low',
        'agent_contract:',
        '  objective: Prepare the email draft only',
        'allowed_tools:',
        '  - outlook_email',
        'blocked_tools:',
        '  - email_send',
        '---',
        '',
        'Prepare a draft for review.',
        '',
      ].join('\n'), 'utf-8');

      const first = await scanActions(engine, { repo });
      expect(first).toMatchObject({ scanned: 1, indexed: 1, removed: 0, source_id: 'default' });
      const rows = await listActions(engine, { limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        slug: 'state/actions/email-draft',
        title: 'Draft follow-up email',
        eligible: true,
        mode: 'agent_assisted',
        risk_level: 'low',
        file_path: actionPath,
      });

      await unlink(actionPath);
      const second = await scanActions(engine, { repo });
      expect(second).toMatchObject({ scanned: 0, indexed: 0, removed: 1, source_id: 'default' });
      expect(await listActions(engine, { limit: 10 })).toHaveLength(0);
    } finally {
      await engine.disconnect().catch(() => {});
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('scan supports scaffold repos where actions live under brain/state/actions', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'voltmind-actions-scaffold-'));
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      const actionsDir = join(repo, 'brain', 'state', 'actions');
      await mkdir(actionsDir, { recursive: true });
      const actionPath = join(actionsDir, 'training.md');
      await writeFile(join(actionsDir, 'README.md'), '# Actions\n\nFolder guide.\n', 'utf-8');
      await writeFile(actionPath, [
        '---',
        'title: Attend training',
        'status: open',
        'automation:',
        '  eligible: true',
        '  mode: agent_assisted',
        '  risk_level: low',
        'agent_contract:',
        '  objective: Prepare training reminder',
        '---',
        '',
      ].join('\n'), 'utf-8');

      const result = await scanActions(engine, { repo });
      expect(result).toMatchObject({
        scanned: 2,
        indexed: 1,
        removed: 0,
        actions_dir: actionsDir,
      });
      const rows = await listActions(engine, { limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        slug: 'state/actions/training',
        title: 'Attend training',
        file_path: actionPath,
      });
    } finally {
      await engine.disconnect().catch(() => {});
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('scan can resolve the action repo from VOLTMIND_ACTIONS_REPO', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'voltmind-actions-env-'));
    const previous = process.env.VOLTMIND_ACTIONS_REPO;
    const engine = new PGLiteEngine();
    try {
      process.env.VOLTMIND_ACTIONS_REPO = repo;
      await engine.connect({});
      await engine.initSchema();
      const actionsDir = join(repo, 'brain', 'state', 'actions');
      await mkdir(actionsDir, { recursive: true });
      await writeFile(join(actionsDir, 'env-action.md'), [
        '---',
        'title: Env routed action',
        'status: open',
        'automation:',
        '  eligible: true',
        '  mode: agent_assisted',
        '  risk_level: low',
        'agent_contract:',
        '  objective: Confirm env-routed scan',
        '---',
        '',
      ].join('\n'), 'utf-8');

      const result = await scanActions(engine);
      expect(result).toMatchObject({
        scanned: 1,
        indexed: 1,
        repo,
        actions_dir: actionsDir,
      });
      const rows = await listActions(engine, { limit: 10 });
      expect(rows[0]).toMatchObject({
        slug: 'state/actions/env-action',
        title: 'Env routed action',
      });
    } finally {
      if (previous === undefined) delete process.env.VOLTMIND_ACTIONS_REPO;
      else process.env.VOLTMIND_ACTIONS_REPO = previous;
      await engine.disconnect().catch(() => {});
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('saveActionPlan and getActionPlan persist generated plans in action_index', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'voltmind-actions-plan-'));
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      const actionsDir = join(repo, 'state', 'actions');
      await mkdir(actionsDir, { recursive: true });
      await writeFile(join(actionsDir, 'plan-target.md'), [
        '---',
        'title: Plan target',
        'status: open',
        'automation:',
        '  eligible: true',
        '  mode: agent_assisted',
        '  risk_level: low',
        'agent_contract:',
        '  objective: Test plan persistence',
        '---',
        '',
      ].join('\n'), 'utf-8');

      await scanActions(engine, { repo });
      await saveActionPlan(engine, 'state/actions/plan-target', {
        plan: [{ phase: '1. Check', steps: ['Read action', 'Persist plan'] }],
        done: { '0:1': true },
      });

      expect(await getActionPlan(engine, 'state/actions/plan-target')).toEqual({
        plan: [{ phase: '1. Check', steps: ['Read action', 'Persist plan'] }],
        done: { '0:1': true },
      });
    } finally {
      await engine.disconnect().catch(() => {});
      await rm(repo, { recursive: true, force: true });
    }
  });
});
