import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { operations, operationsByName } from '../src/core/operations.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';
import { submitTrackedIngestionEvent } from '../src/core/project-tracking-runtime.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const read = (path: string) => readFileSync(path, 'utf8');

describe('long-running project tracking capability injection', () => {
  test('operation contract and generated MCP tools expose client registration and maintenance entrypoints', () => {
    expect(operationsByName.submit_ingestion_event?.scope).toBe('write');
    expect(operationsByName.get_project_tracking_status?.scope).toBe('read');
    expect(operationsByName.reconcile_project_tracking?.scope).toBe('admin');
    expect(operationsByName.register_tracking_evidence?.scope).toBe('write');
    expect(operationsByName.register_tracking_evidence?.params).not.toHaveProperty('source_id');
    expect(operationsByName.submit_ingestion_event?.params).not.toHaveProperty('source_id');
    expect(operationsByName.submit_ingestion_event?.params).toHaveProperty('file_refs');

    const tools = buildToolDefs(operations);
    for (const name of [
      'submit_ingestion_event',
      'get_project_tracking_status',
      'reconcile_project_tracking',
      'register_tracking_evidence',
    ]) {
      expect(tools.some(tool => tool.name === name)).toBe(true);
    }
  });

  test('skills declare matching triggers and runtime tools without client project-write bypasses', () => {
    const ingest = read('skills/ingest/SKILL.md');
    const meeting = read('skills/meeting-ingestion/SKILL.md');
    const project = read('skills/project/SKILL.md');
    const maintain = read('skills/maintain/SKILL.md');
    const resolver = read('skills/RESOLVER.md');

    expect(ingest).toContain('  - submit_ingestion_event');
    expect(meeting).toContain('  - register_tracking_evidence');
    expect(project).toContain('  - get_project_tracking_status');
    expect(project).toContain('  - reconcile_project_tracking');
    expect(maintain).toContain('  - get_project_tracking_status');
    expect(maintain).toContain('  - reconcile_project_tracking');
    expect(ingest).toContain('Client-agent ingest may write `projects/`');
    expect(meeting).toContain('register_tracking_evidence');
    expect(resolver).toContain('"long-running project tracking", "project tracking", "tracking binding"');
    expect(resolver).toContain('"project tracking health", "failed tracking receipts", "reconcile project tracking"');
  });

  test('Host publication and one-shot skillpack propagation carry project skill and Resolver', () => {
    const catalog = JSON.parse(read('skills/manifest.json')) as {
      version: string;
      skills: Array<{ name: string; description: string }>;
    };
    const bundle = JSON.parse(read('openclaw.plugin.json')) as {
      version: string;
      skills: string[];
      shared_deps: string[];
    };
    const project = catalog.skills.find(skill => skill.name === 'project');
    expect(project?.description).toContain('tracking candidates');
    expect(catalog.version).toBe('0.41.20.0');
    expect(bundle.version).toBe('0.41.20.0');
    expect(bundle.skills).toContain('skills/project');
    expect(bundle.shared_deps).toContain('skills/RESOLVER.md');
  });

  test('normalized submission stamps the authorized source and queues raw ingest before tracking', async () => {
    const calls: Array<{ name: string; data?: Record<string, unknown>; opts?: Record<string, unknown> }> = [];
    const engine = {
      executeRaw: async (sql: string) => sql.includes('FROM sources') ? [{ id: 'company-a' }] : [],
    } as unknown as BrainEngine;
    const result = await submitTrackedIngestionEvent(engine, 'company-a', {
      source_kind: 'teams-connector',
      source_uri: 'teams://conversation/example',
      content: 'Milestone reached.',
      event_id: 'event-1',
      event_version: '2',
      file_refs: [{
        schema_version: 1,
        provider: 'filesystem',
        service: 'raidrive',
        root_key: 'synology-public',
        relative_path: 'Public/Projects/Example',
        name: 'Example',
        availability: 'unverified',
      }],
      tracking_refs: [{ provider: 'teams', resource: 'conversation', id: 'conversation-example' }],
      evidence_type: 'teams_thread',
    }, {
      add: async (name, data, opts) => {
        calls.push({ name, data, opts });
        return { id: 42 };
      },
    });

    expect(result).toEqual({ source_id: 'company-a', status: 'queued', job_id: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('ingest_capture');
    expect((calls[0]?.data?.event as { source_id?: string }).source_id).toBe('company-a');
    expect((calls[0]?.data?.event as { file_refs?: unknown[] }).file_refs).toHaveLength(1);
    expect(calls[0]?.data).not.toHaveProperty('page_source_id');
  });

  test('attachment-only changes produce a distinct ingestion idempotency key', async () => {
    const keys: string[] = [];
    const engine = {
      executeRaw: async (sql: string) => sql.includes('FROM sources') ? [{ id: 'company-a' }] : [],
    } as unknown as BrainEngine;
    const queue = {
      add: async (_name: string, _data?: Record<string, unknown>, opts?: Record<string, unknown>) => {
        keys.push(String(opts?.idempotency_key));
        return { id: keys.length };
      },
    };
    const base = {
      source_kind: 'teams-connector',
      source_uri: 'teams://conversation/file-ref-change',
      content: 'Please review the shared folder.',
      event_id: 'event-file-ref-change',
      event_version: '1',
    };
    await submitTrackedIngestionEvent(engine, 'company-a', {
      ...base,
      file_refs: [{
        schema_version: 1,
        provider: 'filesystem',
        service: 'raidrive',
        root_key: 'synology-public',
        relative_path: 'Public/Projects/First',
        name: 'First',
      }],
    }, queue);
    await submitTrackedIngestionEvent(engine, 'company-a', {
      ...base,
      file_refs: [{
        schema_version: 1,
        provider: 'filesystem',
        service: 'raidrive',
        root_key: 'synology-public',
        relative_path: 'Public/Projects/Second',
        name: 'Second',
      }],
    }, queue);

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test('mutating tracking operations reject a client runtime before touching storage', async () => {
    const previousRole = process.env.VOLTMIND_RUNTIME_ROLE;
    process.env.VOLTMIND_RUNTIME_ROLE = 'client';
    const ctx = {
      engine: { kind: 'postgres' },
      sourceId: 'company-a',
      remote: true,
    } as Parameters<typeof operationsByName.submit_ingestion_event.handler>[0];
    try {
      await expect(operationsByName.submit_ingestion_event.handler(ctx, {
        source_kind: 'teams-connector',
        source_uri: 'teams://conversation/example',
        content: 'Progress',
      })).rejects.toMatchObject({ code: 'permission_denied' });
      await expect(operationsByName.reconcile_project_tracking.handler(ctx, {}))
        .rejects.toMatchObject({ code: 'permission_denied' });
    } finally {
      if (previousRole === undefined) delete process.env.VOLTMIND_RUNTIME_ROLE;
      else process.env.VOLTMIND_RUNTIME_ROLE = previousRole;
    }
  });
});
