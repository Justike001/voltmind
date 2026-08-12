import { describe, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import { chmod, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'fs/promises';
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
  finalizeInteractiveActionRun,
  getAction,
  getActionRun,
  listArchivedActions,
  listActions,
  getActionPlan,
  normalizeActionRelatedQueryHits,
  normalizeActionPlan,
  runAction,
  saveUserActionToolRoute,
  saveActionPlan,
  scanPendingInteractiveActionRuns,
  scanActions,
  updateActionFields,
  updateActionStatus,
  type ActionRecord,
} from '../src/core/actions.ts';
import { runActions } from '../src/commands/actions.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  buildCodexExecArgs,
  buildCraftHeadlessArgs,
  CodexExecutor,
  CraftHeadlessExecutor,
  summarizeCodexExecEvents,
  parseCraftStreamEvent,
  resolveExecutor,
  summarizeCraftHeadlessEvents,
  writeCodexExecResult,
  writeCraftHeadlessResult,
  writeInteractiveActionPromptFiles,
  type ActionExecutionResult,
  type InteractiveActionRunEnvelope,
} from '../src/core/action-executor.ts';
import { DefaultActionRunner, parseExecutionOutcome } from '../src/core/action-runner.ts';
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

function codexEnvelopeFor(dir: string, runId = 188): InteractiveActionRunEnvelope {
  return {
    runId,
    sourceId: 'default',
    slug: 'state/actions/codex-exec',
    nonce: `codex-nonce-${runId}`,
    actionDir: dir,
    promptPath: join(dir, 'prompt.md'),
    requestPath: join(dir, 'request.json'),
    resultPath: join(dir, 'result.json'),
    eventsPath: join(dir, 'events.jsonl'),
    launcherPath: join(dir, 'launcher.json'),
    executionContextPath: join(dir, 'execution-context.json'),
    stdoutLogPath: join(dir, 'stdout.log'),
    stderrLogPath: join(dir, 'stderr.log'),
    transcriptPath: join(dir, 'transcript.log'),
    initiator: 'admin-ui',
  };
}

async function installFakeCodexOnPath(dir: string, jsBody: string): Promise<{ pathKey: string; oldPath: string | undefined }> {
  const fakeJs = join(dir, 'fake-codex-bin.js');
  await writeFile(fakeJs, jsBody, 'utf-8');
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const oldPath = process.env[pathKey];
  if (process.platform === 'win32') {
    const cmd = join(dir, 'codex.cmd');
    await writeFile(cmd, `@echo off\r\n"${process.execPath}" "${fakeJs}" %*\r\n`, 'utf-8');
  } else {
    const sh = join(dir, 'codex');
    await writeFile(sh, `#!/bin/sh\n"${process.execPath}" "${fakeJs}" "$@"\n`, 'utf-8');
    await chmod(sh, 0o755);
  }
  process.env[pathKey] = oldPath ? `${dir}${process.platform === 'win32' ? ';' : ':'}${oldPath}` : dir;
  return { pathKey, oldPath };
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
    expect(args).toContain('plugins');
    expect(args).toContain('--json');
    expect(args).toContain('--sandbox');
    expect(args).toContain('danger-full-access');
    expect(args).not.toContain('read-only');
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

  test('resolver no longer exposes a Codex interactive runtime', () => {
    expect(() => resolveExecutor('codex_interactive')).toThrow('Runtime "codex_interactive" is not implemented in Phase 1');
  });

  test('Codex exec JSONL events map to writeback status and markers', async () => {
    const done = summarizeCodexExecEvents([
      {
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'VOLTMIND_RESULT_STATUS: done\nVOLTMIND_RESULT_SUMMARY: Codex draft created.\nVOLTMIND_ARTIFACT_REF: artifact://codex-draft',
        },
      },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    expect(done.status).toBe('done');
    expect(done.summary).toBe('Codex draft created.');
    expect(done.artifactRefs).toContain('artifact://codex-draft');

    const failed = summarizeCodexExecEvents([{ type: 'turn.failed', error: { message: 'boom' } }], { exitCode: 1 });
    expect(failed.status).toBe('failed');
    expect(failed.errors.join('\n')).toContain('boom');

    const dir = await mkdtemp(join(tmpdir(), 'voltmind-codex-result-'));
    try {
      const envelope = codexEnvelopeFor(dir);
      await mkdir(dir, { recursive: true });
      await writeCodexExecResult(envelope, done);
      expect(existsSync(`${envelope.resultPath}.tmp`)).toBe(false);
      const result = JSON.parse(await readFile(envelope.resultPath, 'utf-8')) as Record<string, unknown>;
      expect(result).toMatchObject({
        action_run_id: 188,
        source_id: 'default',
        slug: 'state/actions/codex-exec',
        nonce: 'codex-nonce-188',
        status: 'done',
        summary: 'Codex draft created.',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('fake Codex exec process writes done result for watcher finalization', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'voltmind-codex-fake-'));
    try {
      const fake = join(dir, 'fake-codex.js');
      await writeFile(fake, [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'VOLTMIND_RESULT_STATUS: done\\nVOLTMIND_RESULT_SUMMARY: Fake Codex completed.\\nVOLTMIND_ARTIFACT_REF: artifact://fake-codex' } }));",
        "  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));",
        "});",
      ].join('\n'), 'utf-8');
      const envelope = codexEnvelopeFor(dir);
      const executor = new CodexExecutor({ command: process.execPath, baseArgs: [fake] });
      const result = await executor.execute({
        prompt: 'Create a draft artifact.',
        toolScope: { allowed: [], blocked: [] },
        interactiveRun: envelope,
        timeoutMs: 5_000,
      });
      expect(result.kind).toBe('codex_exec');
      expect(result.writebackStatus).toBe('result_written');
      const writeback = JSON.parse(await readFile(envelope.resultPath, 'utf-8')) as Record<string, unknown>;
      expect(writeback.status).toBe('done');
      expect(writeback.summary).toBe('Fake Codex completed.');
      expect(writeback.artifact_refs).toEqual(['artifact://fake-codex']);
      const events = await readFile(envelope.eventsPath, 'utf-8');
      expect(events).toContain('codex_exec_started');
      expect(events).toContain('codex_exec_event_seen');
      expect(events).toContain('codex_exec_complete');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('fake Codex exec timeout writes failed result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'voltmind-codex-timeout-'));
    try {
      const fake = join(dir, 'fake-codex-timeout.js');
      await writeFile(fake, 'setTimeout(() => {}, 10000);\n', 'utf-8');
      const envelope = codexEnvelopeFor(dir);
      const executor = new CodexExecutor({ command: process.execPath, baseArgs: [fake] });
      const result = await executor.execute({
        prompt: 'This should time out.',
        toolScope: { allowed: [], blocked: [] },
        interactiveRun: envelope,
        timeoutMs: 50,
      });
      expect(result.writebackStatus).toBe('result_written');
      const writeback = JSON.parse(await readFile(envelope.resultPath, 'utf-8')) as Record<string, unknown>;
      expect(writeback.status).toBe('failed');
      expect(String((writeback.errors as string[]).join('\n'))).toContain('codex_exec_timeout');
      const events = await readFile(envelope.eventsPath, 'utf-8');
      expect(events).toContain('codex_exec_timeout');
      expect(events).toContain('codex_exec_error');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

describe('VoltMind Craft headless executor', () => {
  function craftEnvelopeFor(dir: string, runId = 88): InteractiveActionRunEnvelope {
    return {
      runId,
      sourceId: 'default',
      slug: 'state/actions/craft-headless',
      nonce: `craft-nonce-${runId}`,
      actionDir: dir,
      promptPath: join(dir, 'prompt.md'),
      requestPath: join(dir, 'request.json'),
      resultPath: join(dir, 'result.json'),
      eventsPath: join(dir, 'events.jsonl'),
      launcherPath: join(dir, 'launcher.json'),
      executionContextPath: join(dir, 'execution-context.json'),
      stdoutLogPath: join(dir, 'stdout.log'),
      stderrLogPath: join(dir, 'stderr.log'),
      transcriptPath: join(dir, 'transcript.log'),
      initiator: 'admin-ui',
    };
  }

  test('resolver and args expose craft_headless runtime', () => {
    expect(resolveExecutor('craft_headless').kind).toBe('craft_headless');
    const args = buildCraftHeadlessArgs('C:\\tmp\\action', {
      VOLTMIND_CRAFT_SOURCE_SLUGS: 'outlook-email,teams,bad source',
    });
    expect(args).toEqual([
      'run',
      '--workspace-dir', 'C:\\tmp\\action',
      '--output-format', 'stream-json',
      '--no-cleanup',
      '--source', 'outlook-email',
      '--source', 'teams',
    ]);
  });

  test('stream events map to writeback status and machine markers', () => {
    expect(parseCraftStreamEvent('{"type":"complete"}')?.type).toBe('complete');
    const done = summarizeCraftHeadlessEvents([
      { type: 'text_delta', delta: 'VOLTMIND_RESULT_STATUS: done\nVOLTMIND_RESULT_SUMMARY: Draft created.\nVOLTMIND_ARTIFACT_REF: artifact://draft-1' },
      { type: 'complete' },
    ]);
    expect(done.status).toBe('done');
    expect(done.summary).toBe('Draft created.');
    expect(done.artifactRefs).toContain('artifact://draft-1');

    const failed = summarizeCraftHeadlessEvents([{ type: 'error', error: { message: 'boom' } }], { exitCode: 1 });
    expect(failed.status).toBe('failed');
    expect(failed.errors.join('\n')).toContain('boom');

    const interrupted = summarizeCraftHeadlessEvents([{ type: 'interrupted' }]);
    expect(interrupted.status).toBe('blocked');
  });

  test('writes result.json through tmp rename shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'voltmind-craft-result-'));
    try {
      const envelope = craftEnvelopeFor(dir);
      await mkdir(dir, { recursive: true });
      await writeCraftHeadlessResult(envelope, {
        status: 'done',
        summary: 'Adapter wrote the result.',
        artifactRefs: ['artifact://craft'],
        errors: [],
      });
      expect(existsSync(`${envelope.resultPath}.tmp`)).toBe(false);
      const result = JSON.parse(await readFile(envelope.resultPath, 'utf-8')) as Record<string, unknown>;
      expect(result).toMatchObject({
        action_run_id: 88,
        source_id: 'default',
        slug: 'state/actions/craft-headless',
        nonce: 'craft-nonce-88',
        status: 'done',
        summary: 'Adapter wrote the result.',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('fake Craft process writes a done result for watcher finalization', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'voltmind-craft-fake-'));
    try {
      const fake = join(dir, 'fake-craft.js');
      await writeFile(fake, [
        "process.stdin.resume();",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('end', () => {",
        "  console.log(JSON.stringify({ type: 'text_delta', delta: 'VOLTMIND_RESULT_STATUS: done\\nVOLTMIND_RESULT_SUMMARY: Fake Craft completed.\\nVOLTMIND_ARTIFACT_REF: artifact://fake-craft' }));",
        "  console.log(JSON.stringify({ type: 'complete', sessionId: 's1' }));",
        "});",
      ].join('\n'), 'utf-8');
      const envelope = craftEnvelopeFor(dir);
      const executor = new CraftHeadlessExecutor({ command: process.execPath, baseArgs: [fake] });
      const result = await executor.execute({
        prompt: 'Create a draft artifact.',
        toolScope: { allowed: [], blocked: [] },
        interactiveRun: envelope,
        timeoutMs: 5_000,
      });
      expect(result.kind).toBe('craft_headless');
      expect(result.writebackStatus).toBe('result_written');
      const writeback = JSON.parse(await readFile(envelope.resultPath, 'utf-8')) as Record<string, unknown>;
      expect(writeback.status).toBe('done');
      expect(writeback.summary).toBe('Fake Craft completed.');
      expect(writeback.artifact_refs).toEqual(['artifact://fake-craft']);
      const events = await readFile(envelope.eventsPath, 'utf-8');
      expect(events).toContain('craft_started');
      expect(events).toContain('craft_event_seen');
      expect(events).toContain('craft_complete');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('fake Craft timeout writes failed result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'voltmind-craft-timeout-'));
    try {
      const fake = join(dir, 'fake-craft-timeout.js');
      await writeFile(fake, 'setTimeout(() => {}, 10000);\n', 'utf-8');
      const envelope = craftEnvelopeFor(dir);
      const executor = new CraftHeadlessExecutor({ command: process.execPath, baseArgs: [fake] });
      const result = await executor.execute({
        prompt: 'This should time out.',
        toolScope: { allowed: [], blocked: [] },
        interactiveRun: envelope,
        timeoutMs: 50,
      });
      expect(result.writebackStatus).toBe('result_written');
      const writeback = JSON.parse(await readFile(envelope.resultPath, 'utf-8')) as Record<string, unknown>;
      expect(writeback.status).toBe('failed');
      expect(String((writeback.errors as string[]).join('\n'))).toContain('craft_headless_timeout');
      const events = await readFile(envelope.eventsPath, 'utf-8');
      expect(events).toContain('craft_timeout');
      expect(events).toContain('craft_error');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('VoltMind interactive action writeback', () => {
  function envelopeFor(dir: string, runId = 77): InteractiveActionRunEnvelope {
    return {
      runId,
      sourceId: 'default',
      slug: 'state/actions/interactive-writeback',
      nonce: `nonce-${runId}`,
      actionDir: dir,
      promptPath: join(dir, 'prompt.md'),
      requestPath: join(dir, 'request.json'),
      resultPath: join(dir, 'result.json'),
      eventsPath: join(dir, 'events.jsonl'),
      launcherPath: join(dir, 'launcher.json'),
      executionContextPath: join(dir, 'execution-context.json'),
      stdoutLogPath: join(dir, 'stdout.log'),
      stderrLogPath: join(dir, 'stderr.log'),
      transcriptPath: join(dir, 'transcript.log'),
      initiator: 'admin-ui',
    };
  }

  async function writeActionFile(repo: string, name: string): Promise<string> {
    const actionsDir = join(repo, 'state', 'actions');
    await mkdir(actionsDir, { recursive: true });
    const file = join(actionsDir, `${name}.md`);
    await writeFile(file, [
      '---',
      `title: ${name}`,
      'status: in_progress',
      'priority: medium',
      'due: 2026-06-15T17:30',
      'automation:',
      '  eligible: true',
      '  mode: agent_assisted',
      '  runtime: codex',
      '  trigger: due_time',
      '  risk_level: low',
      '  requires_confirmation: false',
      'agent_contract:',
      `  objective: Complete ${name}`,
      '---',
      '',
      '## Action',
      '',
      `Complete ${name}.`,
    ].join('\n'), 'utf-8');
    return file;
  }

  async function createPendingRun(
    engine: PGLiteEngine,
    slug: string,
    paths: InteractiveActionRunEnvelope,
  ): Promise<number> {
    const rows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO action_runs (source_id, action_slug, idempotency_key, status, dry_run, prompt, user_prompt, result, error_text, finished_at)
       VALUES ('default', $1, $2, 'interactive_pending', false, '', NULL, '{}'::jsonb, NULL, NULL)
       RETURNING id`,
      [slug, `${slug}|interactive-test|${Date.now()}|${Math.random()}`],
    );
    const runId = rows[0].id;
    const meta = {
      kind: 'interactive_writeback',
      writeback_status: 'interactive_pending',
      action_run_id: runId,
      source_id: 'default',
      slug,
      nonce: paths.nonce,
      action_dir: paths.actionDir,
      prompt_path: paths.promptPath,
      request_path: paths.requestPath,
      result_path: paths.resultPath,
      events_path: paths.eventsPath,
      launcher_path: paths.launcherPath,
      execution_context_path: paths.executionContextPath,
      stdout_log_path: paths.stdoutLogPath,
      stderr_log_path: paths.stderrLogPath,
      transcript_path: paths.transcriptPath,
      plan_context_snapshot: null,
      initiator: 'admin-ui',
    };
    await engine.executeRaw(
      `UPDATE action_runs SET result = $2::jsonb WHERE id = $1`,
      [runId, JSON.stringify(meta)],
    );
    return runId;
  }

  test('interactive prompt files persist with request metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'voltmind-writeback-files-'));
    try {
      const envelope = envelopeFor(dir);
      await writeInteractiveActionPromptFiles('Base action prompt', envelope);
      const request = await readFile(envelope.requestPath, 'utf-8');
      const prompt = await readFile(envelope.promptPath, 'utf-8');

      expect(request).toContain('"protocol": "voltmind-admin-action-writeback"');
      expect(request).toContain('"action_run_id": 77');
      expect(request).toContain('"nonce": "nonce-77"');
      expect(request).toContain('"events_path"');
      expect(request).toContain('"plan_context_snapshot"');
      expect(prompt).toContain('Base action prompt');
      expect(prompt).toContain('VoltMind Interactive Writeback');
      expect(prompt).toContain(envelope.resultPath);
      expect(existsSync(envelope.stdoutLogPath)).toBe(true);
      expect(existsSync(envelope.stderrLogPath)).toBe(true);
      expect(existsSync(envelope.transcriptPath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('finalizer rejects nonce mismatch without changing pending run', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'voltmind-writeback-nonce-'));
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      await writeActionFile(repo, 'nonce-mismatch');
      await scanActions(engine, { repo });
      const actionDir = join(repo, '.voltmind-action-runs', 'nonce-mismatch');
      await mkdir(actionDir, { recursive: true });
      const envelope = envelopeFor(actionDir);
      const slug = 'state/actions/nonce-mismatch';
      const runId = await createPendingRun(engine, slug, { ...envelope, slug });
      await writeFile(envelope.resultPath, JSON.stringify({
        action_run_id: runId,
        source_id: 'default',
        slug,
        nonce: 'wrong-nonce',
        status: 'done',
        summary: 'Should not write back.',
        artifact_refs: [],
        errors: [],
      }, null, 2), 'utf-8');

      await expect(finalizeInteractiveActionRun(engine, runId)).rejects.toThrow(/nonce mismatch/);
      expect((await getActionRun(engine, runId))?.status).toBe('interactive_pending');
    } finally {
      await engine.disconnect().catch(() => {});
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('missing result keeps interactive run pending', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'voltmind-writeback-missing-'));
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      await writeActionFile(repo, 'missing-result');
      await scanActions(engine, { repo });
      const actionDir = join(repo, '.voltmind-action-runs', 'missing-result');
      await mkdir(actionDir, { recursive: true });
      const envelope = envelopeFor(actionDir);
      const slug = 'state/actions/missing-result';
      const runId = await createPendingRun(engine, slug, { ...envelope, slug });

      const result = await finalizeInteractiveActionRun(engine, runId, { allowMissing: true });

      expect(result.finalized).toBe(false);
      expect(result.missing_result).toBe(true);
      expect(result.writeback_status).toBe('interactive_pending');
      expect((await getActionRun(engine, runId))?.status).toBe('interactive_pending');
      expect(result.events?.some(event => event.event === 'watch_missing_result')).toBe(true);
    } finally {
      await engine.disconnect().catch(() => {});
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('watcher finalizes pending run when result file appears', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'voltmind-writeback-watcher-'));
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      await writeActionFile(repo, 'watcher-done');
      await scanActions(engine, { repo });
      const actionDir = join(repo, '.voltmind-action-runs', 'watcher-done');
      await mkdir(actionDir, { recursive: true });
      const envelope = envelopeFor(actionDir);
      const slug = 'state/actions/watcher-done';
      const runId = await createPendingRun(engine, slug, { ...envelope, slug });

      await writeFile(envelope.resultPath, JSON.stringify({
        action_run_id: runId,
        source_id: 'default',
        slug,
        nonce: envelope.nonce,
        status: 'done',
        summary: 'Watcher finalized this interactive action.',
        artifact_refs: ['artifact://watcher-done'],
        errors: [],
      }, null, 2), 'utf-8');

      const scan = await scanPendingInteractiveActionRuns(engine);
      expect(scan.checked).toBeGreaterThanOrEqual(1);
      expect(scan.finalized).toBe(1);
      expect(scan.errors).toEqual([]);
      expect((await getActionRun(engine, runId))?.status).toBe('completed');
      expect((await getAction(engine, slug))?.status).toBe('done');
      const events = await readFile(envelope.eventsPath, 'utf-8');
      expect(events).toContain('watch_finalizing');
      expect(events).toContain('finalizer_completed');
    } finally {
      await engine.disconnect().catch(() => {});
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('Admin codex run creates pending writeback and watcher finalizes it', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'voltmind-admin-codex-writeback-'));
    const engine = new PGLiteEngine();
    let pathRestore: { pathKey: string; oldPath: string | undefined } | null = null;
    try {
      pathRestore = await installFakeCodexOnPath(repo, [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'VOLTMIND_RESULT_STATUS: done\\nVOLTMIND_RESULT_SUMMARY: Admin Codex writeback completed.\\nVOLTMIND_ARTIFACT_REF: artifact://admin-codex' } }));",
        "  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));",
        "});",
      ].join('\n'));
      await engine.connect({});
      await engine.initSchema();
      await writeActionFile(repo, 'admin-codex-writeback');
      await scanActions(engine, { repo });

      const run = await runAction(engine, 'state/actions/admin-codex-writeback', {
        execute: true,
        force: true,
        confirmed: true,
        initiator: 'admin-ui',
      });
      expect(run.status).toBe('interactive_pending');
      expect(run.writeback_status).toBe('interactive_pending');
      expect(run.interactive?.result_path).toBeTruthy();
      expect(existsSync(run.interactive!.result_path)).toBe(true);

      const scan = await scanPendingInteractiveActionRuns(engine);
      expect(scan.finalized).toBe(1);
      expect(scan.errors).toEqual([]);
      const finalizedRun = await getActionRun(engine, run.action_run_id!);
      expect(finalizedRun?.status).toBe('completed');
      expect((await getAction(engine, 'state/actions/admin-codex-writeback'))?.status).toBe('done');
      expect(JSON.stringify(finalizedRun?.result)).toContain('Admin Codex writeback completed.');
    } finally {
      if (pathRestore) {
        if (pathRestore.oldPath === undefined) delete process.env[pathRestore.pathKey];
        else process.env[pathRestore.pathKey] = pathRestore.oldPath;
      }
      await engine.disconnect().catch(() => {});
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('finalizer maps done blocked and failed writebacks', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'voltmind-writeback-finalize-'));
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      const cases: Array<{
        name: string;
        resultStatus: 'done' | 'blocked' | 'failed';
        actionStatus: string;
        runStatus: string;
      }> = [
        { name: 'writeback-done', resultStatus: 'done', actionStatus: 'done', runStatus: 'completed' },
        { name: 'writeback-blocked', resultStatus: 'blocked', actionStatus: 'blocked', runStatus: 'blocked' },
        { name: 'writeback-failed', resultStatus: 'failed', actionStatus: 'failed', runStatus: 'failed' },
      ];
      const files = new Map<string, string>();
      for (const item of cases) {
        files.set(item.name, await writeActionFile(repo, item.name));
      }
      await scanActions(engine, { repo });

      for (const item of cases) {
        const slug = `state/actions/${item.name}`;
        const actionDir = join(repo, '.voltmind-action-runs', item.name);
        await mkdir(actionDir, { recursive: true });
        const envelope = envelopeFor(actionDir);
        const runId = await createPendingRun(engine, slug, { ...envelope, slug });
        await writeFile(envelope.resultPath, JSON.stringify({
          action_run_id: runId,
          source_id: 'default',
          slug,
          nonce: envelope.nonce,
          status: item.resultStatus,
          summary: `Interactive ${item.resultStatus} summary.`,
          artifact_refs: [`artifact://${item.name}`],
          errors: item.resultStatus === 'done' ? [] : [`${item.resultStatus} reason`],
        }, null, 2), 'utf-8');

        const finalized = await finalizeInteractiveActionRun(engine, runId);
        const actions = await listActions(engine, { limit: 20 });
        const updated = actions.find(row => row.slug === slug);
        const run = await getActionRun(engine, runId);
        const markdown = await readFile(files.get(item.name)!, 'utf-8');

        expect(finalized.finalized).toBe(true);
        expect(finalized.writeback_status).toBe(item.runStatus);
        expect(updated?.status).toBe(item.actionStatus);
        expect(run?.status).toBe(item.runStatus);
        expect(markdown).toContain(`status: ${item.actionStatus}`);
        expect(markdown).toContain('## Outcome');
        expect(markdown).toContain(`Interactive ${item.resultStatus} summary.`);
      }
    } finally {
      await engine.disconnect().catch(() => {});
      await rm(repo, { recursive: true, force: true });
    }
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
      const enrichedWarnings = (result.related_runtime_context as { warnings: string[] }).warnings;
      const runtimeWarnings = enrichedWarnings.filter((w: string) => !w.startsWith("Identity context not found:"));
      expect(runtimeWarnings).toEqual([]);
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
        selectedPlugins: ['teams', 'outlook-email'],
        selectedTools: ['send_chat_message', 'search_messages'],
        blockedTools: ['send_email'],
      });

      expect(updated.tool_route?.source).toBe('user');
      expect(updated.tool_route?.selected_plugins).toEqual(['teams', 'outlook-email']);
      expect(updated.allowed_tools).toEqual(['send_chat_message', 'search_messages']);
      expect(updated.blocked_tools).toEqual(['send_email']);
      expect(buildActionPrompt(updated, null)).toContain('Selected route: @teams, @outlook-email');
      const text = await readFile(file, 'utf-8');
      expect(text).toContain('allowed_tools:');
      expect(text).toContain('- send_chat_message');
      expect(text).toContain('- search_messages');
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

// Auto-generated content for test/actions.test.ts

describe('VoltMind end-to-end action pipeline', () => {
  test('full pipeline: draft message to Zi Ye via Teams and Email — tool router, plan generation with VoltMind query, context assembly, and interactive writeback', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'voltmind-e2e-'));
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();

      const pageId = await insertTestPage(engine, 'people/zi-ye', 'Zi Ye', [
        '# Zi Ye',
        '',
        'Zi Ye is a product manager responsible for VoltMind integrations.',
        '',
        '## Contact',
        '- Email: zi.ye@example.com',
        '- Teams: @Zi Ye',
        '',
        '## Current Work',
        '- Owns the Teams and Email connector integration roadmap.',
        '- Reviews all customer-facing draft messages before send.',
        '- Preferred communication style: concise and structured, with bullet-point summaries.',
      ].join('\n'));

      const actionsDir = join(repo, 'state', 'actions');
      await mkdir(actionsDir, { recursive: true });
      const slug = 'state/actions/draft-zi-ye-message';
      await writeFile(join(actionsDir, 'draft-zi-ye-message.md'), [
        '---',
        'title: Draft message to Zi Ye via Teams and Email',
        'status: in_progress',
        'priority: high',
        'due: 2026-07-01T10:00',
        'automation:',
        '  eligible: true',
        '  mode: agent_executable',
        '  runtime: codex',
        '  trigger: manual',
        '  risk_level: low',
        '  requires_confirmation: false',
        'related_people:',
        '  - people/zi-ye',
        'agent_contract:',
        '  objective: Draft a coordinated message to Zi Ye via both Teams and Email about the VoltMind writeback feature rollout.',
        '  success_criteria:',
        '    - Teams message drafted in Zi Ye\'s preferred tone',
        '    - Email drafted with full context',
        '    - Both messages reference Zi Ye\'s current work from their vault page',
        '  output_target:',
        '    type: draft',
        'allowed_tools:',
        '  - outlook_email',
        '  - teams',
        'max_autonomy: draft_only',
        '---',
        '',
        '## Action',
        '',
        'Coordinate with Zi Ye about the new interactive writeback feature in VoltMind Admin Actions.',
        'Zi Ye owns the Teams and Email connectors, so the message should be tailored to their expertise.',
        '',
        '1. Check Zi Ye\'s vault page for current work and preferred communication style',
        '2. Draft a Teams message with the key points',
        '3. Draft an email with full context',
      ].join('\n'), 'utf-8');

      await scanActions(engine, { repo });

      // Phase 3: Tool Router selects email + teams
      const fakeRegistry = registry([
        { name: 'outlook-email', displayName: 'Outlook Email', description: 'Triage Outlook mail.', category: 'Communication', skills: [{ name: 'outlook-email-reply-drafting', description: 'Draft Outlook email replies.', tools: ['search_messages', 'create_reply_draft'] }] },
        { name: 'teams', displayName: 'Teams', description: 'Review and send Teams messages.', category: 'Communication', skills: [{ name: 'teams-messages', description: 'Compose Teams messages.', tools: ['send_chat_message', 'search'] }] },
        { name: 'outlook-calendar', displayName: 'Outlook Calendar', description: 'Schedule meetings.', category: 'Calendar', skills: [{ name: 'outlook-calendar-group-scheduler', description: 'Find meeting times.', tools: ['get_schedule', 'create_event'] }] },
      ]);

      const toolRoute = await routeActionToolsFromRegistry(action({
        slug, title: 'Draft message to Zi Ye via Teams and Email',
        allowed_tools: ['outlook_email', 'teams'],
        agent_contract: { objective: 'Draft a coordinated message to Zi Ye via both Teams and Email.' },
      }), fakeRegistry, { allowLlm: false });

      expect(toolRoute.selected_plugins).toContain('outlook-email');
      expect(toolRoute.selected_plugins).toContain('teams');
      await saveUserActionToolRoute(engine, slug, { sourceId: 'default', selectedPlugins: toolRoute.selected_plugins, selectedTools: [...new Set(toolRoute.selected_tools)], blockedTools: toolRoute.blocked_tools, notes: 'Dual-channel: Teams + Email' });

      // Phase 4: Generate Plan with real VoltMind query for Zi Ye page
      const dispatcherCalls: Array<{ name: string; query: string }> = [];
      const toolDispatcher = async (name: string, params: Record<string, unknown> | undefined, _opts: unknown) => {
        dispatcherCalls.push({ name, query: String(params?.query || '') });
        if (name === 'query' && params?.query) {
          const query = String(params.query).toLowerCase();
          const rows = await engine.executeRaw<{ slug: string; title: string; compiled_truth: string }>(
            `SELECT p.slug, p.title, p.compiled_truth FROM pages p
              WHERE ($1 LIKE '%zi-ye%' AND p.slug = 'people/zi-ye')
                 OR p.slug LIKE $2
                 OR lower(p.title) LIKE $2
              LIMIT 3`,
            [query, `%${query}%`],
          );
          const hits = rows.map(r => ({ slug: r.slug, page_id: 0, title: r.title, type: 'person', chunk_text: (r.compiled_truth || '').slice(0, 500), chunk_source: 'compiled_truth', chunk_id: 0, chunk_index: 0, score: 0.95, stale: false, source_id: 'default', snippet: (r.compiled_truth || '').slice(0, 300) }));
          return { content: [{ type: 'text' as const, text: JSON.stringify(hits) }] };
        }
        return { content: [{ type: 'text' as const, text: '[]' }] };
      };

      let capturedPlanPrompt = '';
      const planResult = await generateAdminActionPlan(engine, slug, {
        sourceId: 'default',
        userPrompt: 'Focus on the writeback feature.',
        toolDispatcher,
        generatePlan: async (prompt: string) => {
          capturedPlanPrompt = prompt;
          return { raw: JSON.stringify({ plan: [
            { phase: 'Research', steps: ['Query Zi Ye vault page for preferences'] },
            { phase: 'Draft Teams', steps: ['Draft Teams message with writeback points', 'Align tone with vault'] },
            { phase: 'Draft Email', steps: ['Draft email with full context', 'Reference Zi Ye connector expertise'] },
          ] }), plan: [
            { phase: 'Research', steps: ['Query Zi Ye vault page for preferences'] },
            { phase: 'Draft Teams', steps: ['Draft Teams message with writeback points', 'Align tone with vault'] },
            { phase: 'Draft Email', steps: ['Draft email with full context', 'Reference Zi Ye connector expertise'] },
          ] };
        },
      });

      // Phase 5: Verify context assembly
      expect(dispatcherCalls.length).toBeGreaterThan(0);
      const qCall = dispatcherCalls.find(c => c.name === 'query');
      expect(qCall).toBeDefined();
      expect(qCall!.query).toContain('zi-ye');
      expect(capturedPlanPrompt).toContain('Draft message to Zi Ye');
      expect(capturedPlanPrompt).toContain('people/zi-ye');
      expect(capturedPlanPrompt).toContain('preferred communication');

      const savedPlan = await getActionPlan(engine, slug);
      expect(savedPlan).not.toBeNull();
      expect(savedPlan!.plan.length).toBeGreaterThanOrEqual(2);
      expect(savedPlan!.related_runtime_context?.hits[0]?.slug).toBe('people/zi-ye');

      // Phase 6: Build full execution prompt
      const actionRecord = await getAction(engine, slug);
      expect(actionRecord).not.toBeNull();
      const dryRun = await new DefaultActionRunner().run({
        action: actionRecord!,
        engine,
        options: { execute: true, dryRun: true, userPrompt: 'Focus on writeback.', force: true },
      });
      const executionPrompt = dryRun.prompt || '';
      expect(executionPrompt).toContain('## Action Tool Route');
      expect(executionPrompt).toContain('outlook-email');
      expect(executionPrompt).toContain('teams');
      expect(executionPrompt).toContain('writeback feature rollout');
      expect(executionPrompt).toContain('## Admin Plan Runtime Context');
      expect(executionPrompt).toContain('people/zi-ye');
      expect(executionPrompt).toContain('Use Admin Plan Runtime Context before attempting a fresh VoltMind query');

      // Phase 7: Interactive writeback pipeline
      const actionDir = join(repo, '.voltmind-action-runs', 'e2e-writeback');
      await mkdir(actionDir, { recursive: true });
      const envelope: InteractiveActionRunEnvelope = {
        runId: 0, sourceId: 'default', slug,
        nonce: 'e2e-nonce-' + Date.now(),
        actionDir, promptPath: join(actionDir, 'prompt.md'),
        requestPath: join(actionDir, 'request.json'),
        resultPath: join(actionDir, 'result.json'),
        eventsPath: join(actionDir, 'events.jsonl'),
        launcherPath: join(actionDir, 'launcher.json'),
        executionContextPath: join(actionDir, 'execution-context.json'),
        stdoutLogPath: join(actionDir, 'stdout.log'),
        stderrLogPath: join(actionDir, 'stderr.log'),
        transcriptPath: join(actionDir, 'transcript.log'),
        initiator: 'admin-ui',
      };

      const ikey = `${slug}|e2e|${Date.now()}|${Math.random()}`;
      const rrows = await engine.executeRaw<{ id: number }>(
        `INSERT INTO action_runs (source_id, action_slug, idempotency_key, status, dry_run, prompt, user_prompt, result, error_text, finished_at) VALUES ('default',$1,$2,'interactive_pending',false,'',NULL,'{}'::jsonb,NULL,NULL) RETURNING id`,
        [slug, ikey],
      );
      const runId = rrows[0].id;
      const meta = { kind: 'interactive_writeback', writeback_status: 'interactive_pending', action_run_id: runId, source_id: 'default', slug, nonce: envelope.nonce, action_dir: actionDir, prompt_path: envelope.promptPath, request_path: envelope.requestPath, result_path: envelope.resultPath, events_path: envelope.eventsPath, launcher_path: envelope.launcherPath, execution_context_path: envelope.executionContextPath, stdout_log_path: envelope.stdoutLogPath, stderr_log_path: envelope.stderrLogPath, transcript_path: envelope.transcriptPath, plan_context_snapshot: savedPlan!.related_runtime_context ?? null, initiator: 'admin-ui' };
      await engine.executeRaw(`UPDATE action_runs SET result=$2::jsonb WHERE id=$1`, [runId, JSON.stringify(meta)]);
      envelope.runId = runId;

      await writeInteractiveActionPromptFiles(executionPrompt, envelope, savedPlan!.related_runtime_context ?? null);
      expect(existsSync(envelope.promptPath)).toBe(true);
      expect(existsSync(envelope.requestPath)).toBe(true);

      const reqJson = JSON.parse(await readFile(envelope.requestPath, 'utf-8'));
      expect(reqJson.protocol).toBe('voltmind-admin-action-writeback');
      expect(reqJson.action_run_id).toBe(runId);
      expect(reqJson.plan_context_snapshot.hits[0].slug).toBe('people/zi-ye');

      const promptMd = await readFile(envelope.promptPath, 'utf-8');
      expect(promptMd).toContain('VoltMind Interactive Writeback');
      expect(promptMd).toContain('Prefer the plan_context_snapshot over running a fresh VoltMind query');

      // Phase 8: Simulate Codex writeback → finalize
      await writeFile(envelope.resultPath, JSON.stringify({
        action_run_id: runId, source_id: 'default', slug, nonce: envelope.nonce,
        status: 'done',
        summary: 'Drafted Teams message and email to Zi Ye about the VoltMind writeback feature. Both drafts reference Zi Ye connector expertise and preferred communication style from vault page.',
        artifact_refs: ['teams://draft/to-zi-ye-writeback-rollout', 'email://draft/to-zi-ye-writeback-feature'],
        errors: [],
        plan_done: { '0:0': true, '1:0': true, '1:1': true, '2:0': true, '2:1': true },
      }, null, 2), 'utf-8');

      const finalized = await finalizeInteractiveActionRun(engine, runId);
      expect(finalized.finalized).toBe(true);
      expect(finalized.writeback_status).toBe('completed');
      expect(finalized.outcome?.success).toBe(true);
      expect(finalized.outcome?.summary).toContain('Zi Ye');

      const updatedAction = await getAction(engine, slug);
      expect(updatedAction).not.toBeNull();
      expect(updatedAction!.status).toBe('done');
      expect(updatedAction!.outcome).toContain('Zi Ye');
      expect(updatedAction!.completed_at).not.toBeNull();
      expect(updatedAction!.archived_at).not.toBeNull();

      const run = await getActionRun(engine, runId);
      expect(run).not.toBeNull();
      expect(run!.status).toBe('completed');
      expect(run!.finished_at).not.toBeNull();

      const updatedFile = await readFile(join(actionsDir, 'draft-zi-ye-message.md'), 'utf-8');
      expect(updatedFile).toContain('status: done');
      expect(updatedFile).toContain('## Outcome');
      expect(updatedFile).toContain('Zi Ye');

    } finally {
      await engine.disconnect().catch(() => {});
      await rm(repo, { recursive: true, force: true });
    }
  });
});

async function insertTestPage(engine: PGLiteEngine, slug: string, title: string, body: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (source_id, slug, title, type, page_kind, compiled_truth, frontmatter, content_hash, updated_at)
     VALUES ('default', $1, $2, 'person', 'markdown', $3, '{}'::jsonb, '', now())
     ON CONFLICT (source_id, slug) DO NOTHING
     RETURNING id`,
    [slug, title, body],
  );
  if (rows.length > 0 && rows[0].id) return rows[0].id;
  const existing = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE source_id = 'default' AND slug = $1 LIMIT 1`, [slug],
  );
  return existing[0]?.id ?? 0;
}
