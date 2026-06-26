import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildActionPlanPromptWithContext,
  buildActionStepRegeneratePrompt,
  buildActionPrompt,
  collectActionRelatedQueryRequests,
  computeActionUrgencyScore,
  dedupeAndCapActionRelatedHits,
  evaluateActionPolicy,
  listArchivedActions,
  listActions,
  getActionPlan,
  normalizeActionRelatedQueryHits,
  normalizeActionPlan,
  saveUserActionToolRoute,
  saveActionPlan,
  scanActions,
  updateActionFields,
  updateActionStatus,
  type ActionRecord,
} from '../src/core/actions.ts';
import { runActions } from '../src/commands/actions.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  buildCodexExecArgs,
  buildCodexInteractiveArgs,
  buildCodexInteractiveLaunch,
  resolveCodexInteractiveCommand,
  type ActionExecutionResult,
} from '../src/core/action-executor.ts';
import { parseExecutionOutcome } from '../src/core/action-runner.ts';
import { routeActionToolsFromRegistry } from '../src/core/action-tool-router.ts';
import type { PluginRegistry } from '../src/core/plugin-registry.ts';
import { generateAdminActionPlan } from '../src/commands/serve-http.ts';

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
    requires_confirmation: false,
    requires_approval: false,
    max_autonomy: 'draft_only',
    approved_at: null,
    approved_by: null,
    started_at: null,
    completed_at: null,
    archived_at: null,
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
    related_context: {
      related_people: [],
      related_project: null,
      related_systems: [],
      related_entities: [],
      related_projects: [],
      related_workstream: null,
    },
    agent: null,
    skill: null,
    user_prompt: null,
    tool_route: null,
    file_path: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function registry(plugins: Array<{
  name: string;
  displayName?: string;
  description?: string;
  category?: string;
  skills?: Array<{ name: string; description: string; tools?: string[] }>;
}>): PluginRegistry {
  const skillIndex: PluginRegistry['skillIndex'] = new Map();
  const toolIndex = new Map<string, string[]>();
  const descriptors = plugins.map(plugin => ({
    name: plugin.name,
    displayName: plugin.displayName ?? plugin.name,
    description: plugin.description ?? '',
    category: plugin.category ?? 'Other',
    repoPath: `C:\\plugins\\${plugin.name}`,
    skills: (plugin.skills ?? []).map(skill => {
      const descriptor = {
        name: skill.name,
        description: skill.description,
        referencedTools: skill.tools ?? [],
        filePath: `C:\\plugins\\${plugin.name}\\skills\\${skill.name}\\SKILL.md`,
      };
      skillIndex.set(skill.name, descriptor);
      for (const tool of descriptor.referencedTools) {
        toolIndex.set(tool, [...(toolIndex.get(tool) ?? []), plugin.name]);
      }
      return descriptor;
    }),
  }));
  return { plugins: descriptors, skillIndex, toolIndex };
}

describe('VoltMind actions policy', () => {
  test('allows low-risk draft-only agent-assisted action', () => {
    expect(evaluateActionPolicy(action()).allowed).toBe(true);
  });

  test('requires approval for medium risk', () => {
    expect(evaluateActionPolicy(action({ risk_level: 'medium' })).allowed).toBe(false);
    expect(evaluateActionPolicy(action({ risk_level: 'medium', approved_at: new Date().toISOString() })).allowed).toBe(true);
  });

  test('blocks high and restricted actions', () => {
    expect(evaluateActionPolicy(action({ risk_level: 'high' })).allowed).toBe(false);
    expect(evaluateActionPolicy(action({ risk_level: 'restricted' })).allowed).toBe(false);
  });

  test('does not run future actions unless forced', () => {
    const future = action({ due_at: new Date(Date.now() + 60_000).toISOString() });
    expect(evaluateActionPolicy(future).allowed).toBe(false);
    expect(evaluateActionPolicy(future, { force: true }).allowed).toBe(true);
  });

  test('allows due on-schedule actions through the execution gate', () => {
    const scheduled = action({ status: 'on_schedule', due_at: new Date(Date.now() - 60_000).toISOString() });
    expect(evaluateActionPolicy(scheduled).allowed).toBe(true);
  });

  test('requires confirmation when action asks for it', () => {
    const result = evaluateActionPolicy(action({ requires_confirmation: true }));
    expect(result).toMatchObject({
      allowed: false,
      requiresConfirmation: true,
      reason: 'action requires confirmation',
    });
  });
});

describe('VoltMind Codex Apps connector execution', () => {
  function execResult(overrides: Partial<ActionExecutionResult> = {}): ActionExecutionResult {
    return {
      kind: 'codex_exec',
      exitCode: 0,
      args: [],
      stdout: '',
      stderr: '',
      wallMs: 10,
      ...overrides,
    };
  }

  test('CodexExecutor config enables apps without mixing approval mechanisms', () => {
    const args = buildCodexExecArgs('E:\\gbrain\\VoltMind', {
      VOLTMIND_CODEX_OUTLOOK_EMAIL_APP_ID: 'microsoft_outlook_email',
      VOLTMIND_CODEX_OUTLOOK_EMAIL_SEND_TOOL_ID: 'send_email',
      VOLTMIND_CODEX_OUTLOOK_EMAIL_DRAFT_TOOL_ID: 'create_draft',
    });

    expect(args).toContain('exec');
    expect(args).toContain('--enable');
    expect(args).toContain('apps');
    expect(args).toContain('--json');
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).toContain('-c');
    expect(args).toContain('approval_policy="never"');
    expect(args).toContain('apps._default.enabled=true');
    expect(args).toContain('apps._default.destructive_enabled=false');
    expect(args).toContain('apps._default.open_world_enabled=false');
    expect(args).toContain('apps.microsoft_outlook_email.enabled=true');
    expect(args).toContain('apps.microsoft_outlook_email.default_tools_enabled=true');
    expect(args).toContain('apps.microsoft_outlook_email.default_tools_approval_mode="approve"');
    expect(args).toContain('apps.microsoft_outlook_email.tools.send_email.approval_mode="approve"');
    expect(args).toContain('apps.microsoft_outlook_email.tools.create_draft.approval_mode="approve"');
    expect(args).not.toContain('--ask-for-approval');
    expect(args).not.toContain('apps._default.default_tools_approval_mode="approve"');
  });

  test('Codex interactive args avoid connector-hydration overrides', () => {
    const args = buildCodexInteractiveArgs('E:\\gbrain\\VoltMind', 'E:\\gbrain\\VoltMind\\.voltmind-codex-interactive-test\\action-prompt.md');

    expect(args).toContain('--cd');
    expect(args).toContain('E:\\gbrain\\VoltMind');
    expect(args).not.toContain('--enable');
    expect(args).not.toContain('apps');
    expect(args).not.toContain('--sandbox');
    expect(args).not.toContain('read-only');
    expect(args).not.toContain('--json');
    expect(args).not.toContain('exec');
    expect(args).not.toContain('approval_policy="never"');
    expect(args).not.toContain('apps.microsoft_outlook_email.default_tools_approval_mode="prompt"');
    expect(args).not.toContain('--add-dir');
    expect(args[args.length - 1]).toBe('Read and execute the VoltMind action prompt from this file: E:\\gbrain\\VoltMind\\.voltmind-codex-interactive-test\\action-prompt.md');
  });

  test('Codex interactive command can use an explicit binary path', () => {
    expect(resolveCodexInteractiveCommand({ VOLTMIND_CODEX_BIN: 'C:\\Tools\\codex.exe' })).toBe('C:\\Tools\\codex.exe');
  });

  test('Codex interactive launch wraps PowerShell ps1 shims without shell splitting', () => {
    const launch = buildCodexInteractiveLaunch(['--enable', 'apps', 'Read and execute file C:\\Temp\\action-prompt.md'], {
      VOLTMIND_CODEX_BIN: 'C:\\Users\\example\\AppData\\Roaming\\npm\\codex.ps1',
    });
    expect(launch.command.toLowerCase()).toContain('powershell');
    expect(launch.args).toContain('-File');
    expect(launch.args).toContain('C:\\Users\\example\\AppData\\Roaming\\npm\\codex.ps1');
    expect(launch.args[launch.args.length - 1]).toBe('Read and execute file C:\\Temp\\action-prompt.md');
  });

  test('JSONL connector cancellation fails the action outcome', () => {
    const outcome = parseExecutionOutcome(execResult({
      stdout: [
        JSON.stringify({ type: 'app_tool_call', app_id: 'microsoft_outlook_email', tool: 'send_email', status: 'cancelled' }),
        JSON.stringify({ type: 'message', content: 'Email was not sent.' }),
      ].join('\n'),
    }), {
      action: action({ allowed_tools: ['outlook_email'] }),
    });

    expect(outcome.success).toBe(false);
    expect(outcome.diagnosticCode).toBe('connector_call_failed');
  });

  test('exit 0 final message that says email was not sent fails closed', () => {
    const outcome = parseExecutionOutcome(execResult({
      stdout: 'Email was not sent. The connector call was cancelled.',
    }), {
      action: action({ allowed_tools: ['outlook_email'] }),
    });

    expect(outcome.success).toBe(false);
    expect(outcome.diagnosticCode).toBe('connector_call_failed');
  });

  test('exit 0 final message that says no email was sent fails closed', () => {
    const outcome = parseExecutionOutcome(execResult({
      stdout: JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'Blocked: connector tools do not include a send/create operation. No email was sent.',
        },
      }),
    }), {
      action: action({ allowed_tools: ['outlook_email'] }),
    });

    expect(outcome.success).toBe(false);
    expect(outcome.diagnosticCode).toBe('connector_call_failed');
  });

  test('email action without connector success event fails with connector_not_observed', () => {
    const outcome = parseExecutionOutcome(execResult({
      stdout: JSON.stringify({ type: 'message', content: 'I prepared the email.' }),
    }), {
      action: action({ allowed_tools: ['outlook_email'] }),
    });

    expect(outcome.success).toBe(false);
    expect(outcome.diagnosticCode).toBe('connector_not_observed');
    expect(outcome.errors.join('\n')).toContain('app id is wrong');
  });

  test('email action with Outlook Email connector success event succeeds', () => {
    const outcome = parseExecutionOutcome(execResult({
      stdout: JSON.stringify({
        type: 'app_tool_call',
        app_id: 'microsoft_outlook_email',
        tool: 'create_draft',
        status: 'completed',
        result: { id: 'draft-1' },
      }),
    }), {
      action: action({ allowed_tools: ['outlook_email'] }),
    });

    expect(outcome.success).toBe(true);
  });
});

describe('VoltMind action tool router', () => {
  const fakeRegistry = registry([
    {
      name: 'outlook-email',
      displayName: 'Outlook Email',
      description: 'Triage Outlook mail, draft replies, and search messages.',
      category: 'Communication',
      skills: [
        { name: 'outlook-email-reply-drafting', description: 'Draft Outlook email replies.', tools: ['search_messages', 'create_reply_draft'] },
      ],
    },
    {
      name: 'teams',
      displayName: 'Teams',
      description: 'Review Microsoft Teams chats and send follow-up messages.',
      category: 'Communication',
      skills: [
        { name: 'teams-messages', description: 'Compose and route Microsoft Teams messages.', tools: ['send_chat_message', 'search'] },
      ],
    },
    {
      name: 'outlook-calendar',
      displayName: 'Outlook Calendar',
      description: 'Schedule meetings and inspect calendar availability.',
      category: 'Calendar',
      skills: [
        { name: 'outlook-calendar-group-scheduler', description: 'Find meeting times.', tools: ['get_schedule', 'create_event'] },
      ],
    },
    {
      name: 'browser',
      displayName: 'Browser',
      description: 'Open pages, click controls, and inspect local web apps.',
      category: 'Browser',
      skills: [
        { name: 'browser-control', description: 'Control browser sessions.', tools: ['open', 'click', 'screenshot'] },
      ],
    },
  ]);

  test('returns compact metadata without raw SKILL.md procedure text', async () => {
    const route = await routeActionToolsFromRegistry(action({
      title: 'Draft a follow-up email',
      allowed_tools: [],
      agent_contract: { objective: 'Draft an Outlook email reply to Alice.' },
    }), fakeRegistry, { allowLlm: false, now: new Date('2026-06-25T00:00:00Z') });

    expect(route.selected_plugins).toEqual(['outlook-email']);
    expect(JSON.stringify(route)).toContain('Draft Outlook email replies');
    expect(JSON.stringify(route)).not.toContain('Relevant Actions');
    expect(JSON.stringify(route)).not.toContain('SKILL.md');
  });

  test('deterministically routes common communication and browser actions', async () => {
    const email = await routeActionToolsFromRegistry(action({ title: 'Draft customer email', allowed_tools: [], agent_contract: { objective: 'Draft a customer email.' } }), fakeRegistry, { allowLlm: false });
    const teams = await routeActionToolsFromRegistry(action({ title: 'Send a Teams follow-up message', allowed_tools: [], agent_contract: { objective: 'Send a Microsoft Teams follow-up message.' } }), fakeRegistry, { allowLlm: false });
    const calendar = await routeActionToolsFromRegistry(action({ title: 'Schedule a calendar meeting', allowed_tools: [], agent_contract: { objective: 'Schedule a calendar meeting.' } }), fakeRegistry, { allowLlm: false });
    const browser = await routeActionToolsFromRegistry(action({ title: 'Open browser and inspect admin UI', allowed_tools: [], agent_contract: { objective: 'Open browser and inspect admin UI.' } }), fakeRegistry, { allowLlm: false });

    expect(email.selected_plugins).toEqual(['outlook-email']);
    expect(teams.selected_plugins).toEqual(['teams']);
    expect(calendar.selected_plugins).toEqual(['outlook-calendar']);
    expect(browser.selected_plugins).toEqual(['browser']);
  });

  test('LLM rerank parse failure falls back to deterministic route', async () => {
    const route = await routeActionToolsFromRegistry(action({
      title: 'Send a message',
      allowed_tools: [],
      agent_contract: { objective: 'Decide whether this message belongs in email or Teams.' },
    }), fakeRegistry, {
      allowLlm: true,
      chat: async () => ({ text: 'not valid json' }),
    });

    expect(route.source).toBe('auto');
    expect(route.selected_plugins.length).toBeGreaterThan(0);
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

  test('plan prompt includes action body and related query context', () => {
    const prompt = buildActionPlanPromptWithContext(action({
      related_context: {
        related_people: ['people/alice-example'],
        related_project: 'projects/admin-ui',
        related_systems: [],
        related_entities: [],
        related_projects: [],
        related_workstream: null,
      },
    }), {
      actionBody: '## Action\nShip the admin plan generator.',
      relatedRuntimeContext: {
        warnings: [],
        hits: [{
          field: 'related_project',
          value: 'projects/admin-ui',
          slug: 'projects/admin-ui',
          title: 'Admin UI',
          type: 'project',
          score: 0.91,
          snippet: 'Admin UI owns action review and planning workflows.',
        }],
      },
    });

    expect(prompt).toContain('Action markdown body:');
    expect(prompt).toContain('Ship the admin plan generator.');
    expect(prompt).toContain('Action related frontmatter:');
    expect(prompt).toContain('related_people: people/alice-example');
    expect(prompt).toContain('Related Context From VoltMind Query:');
    expect(prompt).toContain('projects/admin-ui');
    expect(prompt).toContain('Admin UI owns action review');
  });

  test('related query helpers collect parse dedupe and cap runtime context', () => {
    const requests = collectActionRelatedQueryRequests({
      related_people: ['people/alice-example'],
      related_project: 'projects/admin-ui',
      related_systems: [],
      related_entities: [],
      related_projects: ['projects/admin-ui'],
      related_workstream: null,
    });
    expect(requests.map(req => [req.field, req.value])).toEqual([
      ['related_people', 'people/alice-example'],
      ['related_project', 'projects/admin-ui'],
      ['related_projects', 'projects/admin-ui'],
    ]);

    const hits = normalizeActionRelatedQueryHits('related_project', 'projects/admin-ui', [
      {
        slug: 'projects/admin-ui',
        page_id: 1,
        title: 'Admin UI',
        type: 'project',
        chunk_text: 'A'.repeat(900),
        chunk_source: 'compiled_truth',
        chunk_id: 10,
        chunk_index: 0,
        score: 0.8,
        stale: false,
        source_id: 'default',
      },
      { nope: true },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet.length).toBeLessThanOrEqual(700);

    const capped = dedupeAndCapActionRelatedHits([...hits, ...hits, {
      ...hits[0],
      slug: 'projects/other',
      snippet: 'Other project',
    }], 2);
    expect(capped.map(hit => hit.slug)).toEqual(['projects/admin-ui', 'projects/other']);
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
        'related_people:',
        '  - people/alice-example',
        'related_project: projects/fundraise-example',
        'related_projects:',
        '  - projects/growth-example',
        'related_workstream: workstreams/customer-example',
        'related_systems:',
        '  - systems/email',
        'related_entities:',
        '  - companies/acme-example',
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
        related_context: {
          related_people: ['people/alice-example'],
          related_project: 'projects/fundraise-example',
          related_systems: ['systems/email'],
          related_entities: ['companies/acme-example'],
          related_projects: ['projects/growth-example'],
          related_workstream: 'workstreams/customer-example',
        },
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

  test('scan normalizes scalar and plural related frontmatter into related_context', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'voltmind-actions-related-'));
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      const actionsDir = join(repo, 'state', 'actions');
      await mkdir(actionsDir, { recursive: true });
      await writeFile(join(actionsDir, 'related.md'), [
        '---',
        'title: Related target',
        'automation:',
        '  eligible: true',
        '  mode: agent_assisted',
        '  risk_level: low',
        'related_people: people/bob-example',
        'related_project: projects/alpha-example',
        'related_projects: projects/beta-example',
        'related_workstream: workstreams/launch-example',
        'related_systems: systems/admin-ui',
        'related_entities:',
        '  - companies/acme-example',
        '  - concepts/pglite-locks',
        '---',
        '',
      ].join('\n'), 'utf-8');

      await scanActions(engine, { repo });
      const [row] = await listActions(engine, { limit: 10 });
      expect(row.related_context).toEqual({
        related_people: ['people/bob-example'],
        related_project: 'projects/alpha-example',
        related_systems: ['systems/admin-ui'],
        related_entities: ['companies/acme-example', 'concepts/pglite-locks'],
        related_projects: ['projects/beta-example'],
        related_workstream: 'workstreams/launch-example',
      });
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

  test('CLI --execute --dry-run routes through the action runner harness', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'voltmind-actions-cli-execute-'));
    const engine = new PGLiteEngine();
    const originalLog = console.log;
    const output: string[] = [];
    try {
      console.log = (...args: unknown[]) => { output.push(args.map(String).join(' ')); };
      await engine.connect({});
      await engine.initSchema();
      const actionsDir = join(repo, 'state', 'actions');
      await mkdir(actionsDir, { recursive: true });
      await writeFile(join(actionsDir, 'send-test.md'), [
        '---',
        'title: Send test message',
        'status: open',
        'automation:',
        '  eligible: true',
        '  mode: agent_executable',
        '  runtime: codex',
        '  risk_level: low',
        '  requires_confirmation: false',
        'agent_contract:',
        '  objective: Send a dry-run test message',
        '  success_criteria:',
        '    - Harness prompt is generated',
        'allowed_tools:',
        '  - outlook_email',
        'max_autonomy: single_step',
        '---',
        '',
      ].join('\n'), 'utf-8');

      await scanActions(engine, { repo });
      await saveUserActionToolRoute(engine, 'state/actions/send-test', {
        selectedPlugins: ['outlook-email'],
        selectedTools: ['outlook_email'],
        blockedTools: ['email_send'],
      });
      await saveActionPlan(engine, 'state/actions/send-test', {
        plan: [{ phase: 'Phase 1', steps: ['Read the source message', 'Prepare the draft'] }],
      });
      await runActions(engine, ['run', 'state/actions/send-test', '--execute', '--dry-run']);

      const text = output.join('\n');
      expect(text).toContain('[DRY RUN] state/actions/send-test');
      expect(text).toContain('## Action Tool Route');
      expect(text).toContain('Selected route: @outlook-email');
      expect(text).toContain('## Persisted Action Plan');
      expect(text).toContain('Prepare the draft');
      expect(text).not.toContain('Other available plugins');
      expect(text).toContain('You are executing a VoltMind Action as a harnessed agent.');
      expect(text).toContain('You may ONLY use these tools: outlook_email.');
      expect(text).toContain('Success criteria:');
    } finally {
      console.log = originalLog;
      await engine.disconnect().catch(() => {});
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('CLI --execute --interactive --dry-run uses codex_interactive runtime', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'voltmind-actions-cli-interactive-'));
    const engine = new PGLiteEngine();
    const originalLog = console.log;
    const output: string[] = [];
    try {
      console.log = (...args: unknown[]) => { output.push(args.map(String).join(' ')); };
      await engine.connect({});
      await engine.initSchema();
      const actionsDir = join(repo, 'state', 'actions');
      await mkdir(actionsDir, { recursive: true });
      await writeFile(join(actionsDir, 'interactive-test.md'), [
        '---',
        'title: Interactive test message',
        'status: open',
        'automation:',
        '  eligible: true',
        '  mode: agent_executable',
        '  runtime: codex',
        '  risk_level: low',
        '  requires_confirmation: false',
        'agent_contract:',
        '  objective: Hand off to interactive Codex',
        'allowed_tools:',
        '  - outlook_email',
        'max_autonomy: single_step',
        '---',
        '',
      ].join('\n'), 'utf-8');

      await scanActions(engine, { repo });
      await runActions(engine, ['run', 'state/actions/interactive-test', '--execute', '--interactive', '--dry-run']);

      const text = output.join('\n');
      expect(text).toContain('[DRY RUN] state/actions/interactive-test');
      expect(text).toContain('Runtime backend: codex_interactive');
      expect(text).toContain('You may ONLY use these tools: outlook_email.');
    } finally {
      console.log = originalLog;
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
        version: 2,
        plan: [{
          phase: '1. Check',
          steps: [
            { id: 'p1s1', text: 'Read action', done: false, note: '' },
            { id: 'p1s2', text: 'Persist plan', done: true, note: '' },
          ],
        }],
        done: { '0:0': false, '0:1': true },
      });
    } finally {
      await engine.disconnect().catch(() => {});
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('admin plan generation queries related context through injected dispatcher with source scope', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'voltmind-actions-admin-plan-'));
    const engine = new PGLiteEngine();
    const calls: Array<{ name: string; params: Record<string, unknown> | undefined; opts: Record<string, unknown> | undefined }> = [];
    let capturedPrompt = '';
    try {
      await engine.connect({});
      await engine.initSchema();
      const actionsDir = join(repo, 'state', 'actions');
      await mkdir(actionsDir, { recursive: true });
      await writeFile(join(actionsDir, 'plan-related.md'), [
        '---',
        'title: Plan with related context',
        'automation:',
        '  eligible: true',
        '  mode: agent_assisted',
        '  risk_level: low',
        'related_people:',
        '  - people/alice-example',
        'agent_contract:',
        '  objective: Build a tailored plan',
        '---',
        '',
        '## Action',
        '',
        'Use related brain context.',
      ].join('\n'), 'utf-8');

      await scanActions(engine, { repo, sourceId: 'source-a' });
      const result = await generateAdminActionPlan(engine, 'state/actions/plan-related', {
        sourceId: 'source-a',
        userPrompt: 'Keep it crisp',
        toolDispatcher: async (name, params, opts) => {
          calls.push({ name, params, opts: opts as Record<string, unknown> | undefined });
          return {
            content: [{ type: 'text', text: JSON.stringify([{
              slug: 'people/alice-example',
              page_id: 1,
              title: 'Alice Example',
              type: 'person',
              chunk_text: 'Alice owns the relevant admin planning workflow.',
              chunk_source: 'compiled_truth',
              chunk_id: 1,
              chunk_index: 0,
              score: 0.7,
              stale: false,
              source_id: 'source-a',
            }]) }],
          };
        },
        generatePlan: async (prompt) => {
          capturedPrompt = prompt;
          return { raw: JSON.stringify({ plan: [{ phase: 'Phase 1', steps: ['Read related context'] }] }), plan: [{ phase: 'Phase 1', steps: ['Read related context'] }] };
        },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        name: 'query',
        params: { source_id: 'source-a', detail: 'medium', limit: 3 },
        opts: { remote: false, sourceId: 'source-a' },
      });
      expect(String(calls[0].params?.query)).toContain('people/alice-example');
      expect(capturedPrompt).toContain('Use related brain context.');
      expect(capturedPrompt).toContain('Alice owns the relevant admin planning workflow.');
      expect((result.related_runtime_context as { warnings: string[] }).warnings).toEqual([]);
      expect(result.plan).toEqual([{ phase: 'Phase 1', steps: [{ id: 'p1s1', text: 'Read related context', done: false, note: '' }] }]);
    } finally {
      await engine.disconnect().catch(() => {});
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('saveUserActionToolRoute persists user choice and writes markdown tools', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'voltmind-actions-route-save-'));
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      const actionsDir = join(repo, 'state', 'actions');
      await mkdir(actionsDir, { recursive: true });
      const file = join(actionsDir, 'route-target.md');
      await writeFile(file, [
        '---',
        'title: Route target',
        'status: open',
        'automation:',
        '  eligible: true',
        '  mode: agent_assisted',
        '  risk_level: low',
        'agent_contract:',
        '  objective: Send a Teams follow-up',
        '---',
        '',
      ].join('\n'), 'utf-8');

      await scanActions(engine, { repo });
      const updated = await saveUserActionToolRoute(engine, 'state/actions/route-target', {
        selectedPlugins: ['teams'],
        selectedTools: ['send_chat_message'],
        blockedTools: ['send_email'],
      });

      expect(updated.tool_route?.source).toBe('user');
      expect(updated.allowed_tools).toEqual(['send_chat_message']);
      expect(updated.blocked_tools).toEqual(['send_email']);
      const text = await readFile(file, 'utf-8');
      expect(text).toContain('allowed_tools:');
      expect(text).toContain('- send_chat_message');
      expect(text).toContain('blocked_tools:');
      expect(text).toContain('- send_email');
    } finally {
      await engine.disconnect().catch(() => {});
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('scan normalizes legacy scheduled/watch modes into current mode taxonomy', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'voltmind-actions-legacy-mode-'));
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      const actionsDir = join(repo, 'state', 'actions');
      await mkdir(actionsDir, { recursive: true });
      await writeFile(join(actionsDir, 'scheduled.md'), [
        '---',
        'title: Scheduled action',
        'automation:',
        '  eligible: true',
        '  mode: scheduled_agent',
        '  risk_level: low',
        '---',
        '',
      ].join('\n'), 'utf-8');
      await writeFile(join(actionsDir, 'watch.md'), [
        '---',
        'title: Watch action',
        'automation:',
        '  eligible: true',
        '  mode: watch_agent',
        '  risk_level: low',
        '---',
        '',
      ].join('\n'), 'utf-8');

      await scanActions(engine, { repo });
      const rows = await listActions(engine, { limit: 10 });
      expect(rows.map(r => r.mode)).toEqual(['agent_assisted', 'agent_assisted']);
      expect(rows.map(r => r.trigger).sort()).toEqual(['due_time', 'watch_event']);
    } finally {
      await engine.disconnect().catch(() => {});
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('scan normalizes legacy action statuses before indexing', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'voltmind-actions-legacy-status-'));
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      const actionsDir = join(repo, 'state', 'actions');
      await mkdir(actionsDir, { recursive: true });
      const cases = [
        ['active', 'in_progress'],
        ['completed', 'done'],
        ['cancelled', 'canceled'],
        ['scheduled', 'on_schedule'],
        ['pending', 'open'],
        ['unknown_external_state', 'open'],
      ];
      for (const [rawStatus] of cases) {
        await writeFile(join(actionsDir, `${rawStatus}.md`), [
          '---',
          `title: ${rawStatus}`,
          `status: ${rawStatus}`,
          'automation:',
          '  eligible: true',
          '  mode: agent_assisted',
          '  risk_level: low',
          '---',
          '',
        ].join('\n'), 'utf-8');
      }

      await scanActions(engine, { repo });
      const rows = await engine.executeRaw<{ slug: string; status: string }>(
        `SELECT slug, status FROM action_index ORDER BY slug`,
      );
      expect(rows.map(row => [row.slug.replace(/^state\/actions\//, ''), row.status])).toEqual(
        cases.map(([, normalized], index) => [`${cases[index][0]}`, normalized]).sort((a, b) => a[0].localeCompare(b[0])),
      );
    } finally {
      await engine.disconnect().catch(() => {});
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('updateActionFields writes mode priority and due back to markdown frontmatter', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'voltmind-actions-update-fields-'));
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      const actionsDir = join(repo, 'state', 'actions');
      await mkdir(actionsDir, { recursive: true });
      const file = join(actionsDir, 'review.md');
      await writeFile(file, [
        '---',
        'title: Review task',
        'priority: low',
        'automation:',
        '  eligible: true',
        '  mode: manual',
        '  risk_level: low',
        '---',
        '',
      ].join('\n'), 'utf-8');
      await scanActions(engine, { repo });

      await updateActionFields(engine, 'state/actions/review', {
        mode: 'agent_assisted',
        priority: 'high',
        dueAt: '2026-06-20T09:45',
      });
      const raw = await readFile(file, 'utf-8');
      expect(raw).toContain('priority: high');
      expect(raw).toContain('mode: agent_assisted');
      expect(raw).toContain("due: '2026-06-20T09:45'");

      await scanActions(engine, { repo });
      const row = (await listActions(engine, { limit: 10 }))[0];
      expect(row).toMatchObject({ mode: 'agent_assisted', priority: 'high' });

      await updateActionFields(engine, 'state/actions/review', {
        priority: null,
        dueAt: null,
      });
      const clearedRaw = await readFile(file, 'utf-8');
      expect(clearedRaw).not.toContain('priority:');
      expect(clearedRaw).not.toContain('due:');
      expect(clearedRaw).not.toContain('run_at:');
      const cleared = (await listActions(engine, { limit: 10 }))[0];
      expect(cleared.priority).toBeNull();
      expect(cleared.due_at).toBeNull();
    } finally {
      await engine.disconnect().catch(() => {});
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('computeActionUrgencyScore weights deadline priority and risk', () => {
    const now = new Date('2026-06-16T00:00:00Z');
    const urgent = computeActionUrgencyScore(action({
      due_at: '2026-06-15T00:00:00Z',
      priority: 'urgent',
      risk_level: 'high',
    }), now);
    const later = computeActionUrgencyScore(action({
      due_at: null,
      priority: 'low',
      risk_level: 'low',
    }), now);
    expect(urgent).toBeGreaterThan(later);
    expect(urgent).toBeCloseTo(0.97, 2);
  });

  test('normalizeActionPlan upgrades v1 steps and preserves done state', () => {
    expect(normalizeActionPlan({
      plan: [{ phase: 'Phase 1', steps: ['A', 'B'] }],
      done: { '0:1': true },
    })).toEqual({
      version: 2,
      plan: [{
        phase: 'Phase 1',
        steps: [
          { id: 'p1s1', text: 'A', done: false, note: '' },
          { id: 'p1s2', text: 'B', done: true, note: '' },
        ],
      }],
      done: { '0:0': false, '0:1': true },
    });
  });

  test('plan prompts include identity context previous plan and step notes', () => {
    const plan = normalizeActionPlan({
      plan: [{ phase: 'Phase 1', steps: [{ id: 's1', text: 'Old step', done: false, note: 'Make it shorter' }] }],
    })!;
    const prompt = buildActionPlanPromptWithContext(action({
      outcome: 'A ready draft',
      next_step: 'Review it',
    }), {
      identityContext: { user_md: 'USER PREFS', soul_md: 'SOUL VOICE', found: [], missing: [] },
      previousPlan: plan,
      regenerateInstructions: 'Tighten the plan',
      userPrompt: 'Use bullets',
    });
    expect(prompt).toContain('Outcome: A ready draft');
    expect(prompt).toContain('Next Step: Review it');
    expect(prompt).toContain('USER PREFS');
    expect(prompt).toContain('SOUL VOICE');
    expect(prompt).toContain('Tighten the plan');
    expect(prompt).toContain('Use bullets');

    const stepPrompt = buildActionStepRegeneratePrompt(action(), plan, 0, 0, 'One line only', null);
    expect(stepPrompt).toContain('Old step');
    expect(stepPrompt).toContain('Make it shorter');
    expect(stepPrompt).toContain('One line only');
  });

  test('manual archive writes completion timestamps and exposes elapsed archive rows', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'voltmind-actions-archive-'));
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      const actionsDir = join(repo, 'state', 'actions');
      await mkdir(actionsDir, { recursive: true });
      await writeFile(join(actionsDir, 'manual.md'), [
        '---',
        'title: Manual task',
        'automation:',
        '  eligible: true',
        '  mode: manual',
        '  risk_level: low',
        '---',
        '',
      ].join('\n'), 'utf-8');
      await scanActions(engine, { repo });
      await saveActionPlan(engine, 'state/actions/manual', {
        plan: [{ phase: 'Phase 1', steps: [{ id: 's1', text: 'Do it', done: true, note: '' }] }],
      });
      await updateActionStatus(engine, 'state/actions/manual', 'done');
      const rows = await listArchivedActions(engine, { limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0].completed_at).toBeTruthy();
      expect(rows[0].archived_at).toBeTruthy();
      expect(rows[0].elapsed_ms).not.toBeNull();
    } finally {
      await engine.disconnect().catch(() => {});
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('status updates normalize legacy scheduled to on_schedule', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'voltmind-actions-on-schedule-'));
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      const actionsDir = join(repo, 'state', 'actions');
      const file = join(actionsDir, 'legacy-schedule.md');
      await mkdir(actionsDir, { recursive: true });
      await writeFile(file, [
        '---',
        'title: Legacy schedule task',
        'status: open',
        'automation:',
        '  eligible: true',
        '  mode: agent_assisted',
        '  risk_level: low',
        '---',
        '',
      ].join('\n'), 'utf-8');
      await scanActions(engine, { repo });

      const updated = await updateActionStatus(engine, 'state/actions/legacy-schedule', 'scheduled');
      expect(updated.status).toBe('on_schedule');
      expect(await readFile(file, 'utf-8')).toContain('status: on_schedule');
    } finally {
      await engine.disconnect().catch(() => {});
      await rm(repo, { recursive: true, force: true });
    }
  });
});
