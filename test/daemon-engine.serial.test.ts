import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callLocalDaemon, LOCAL_DAEMON_RPC_PROTOCOL_VERSION, type LocalDaemonState } from '../src/core/local-daemon.ts';
import { resolveDaemonBackedServeRuntime } from '../src/core/daemon-engine.ts';

let tmpHome: string | null = null;
const originalHome = process.env.VOLTMIND_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.VOLTMIND_HOME;
  else process.env.VOLTMIND_HOME = originalHome;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = null;
});

function setTempHome(): string {
  tmpHome = mkdtempSync(join(tmpdir(), 'voltmind-daemon-engine-'));
  process.env.VOLTMIND_HOME = tmpHome;
  mkdirSync(join(tmpHome, '.voltmind'), { recursive: true });
  return tmpHome;
}

function writeDaemonState(state: LocalDaemonState): void {
  const home = setTempHome();
  writeFileSync(join(home, '.voltmind', 'daemon.json'), JSON.stringify(state, null, 2));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function withFakeDaemon(
  handler: (body: any, req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ state: LocalDaemonState; requests: any[]; close: () => Promise<void> }> {
  const requests: any[] = [];
  const token = 'test-token';
  const server = createServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid, version: '0.0.0-test', rpc_protocol_version: LOCAL_DAEMON_RPC_PROTOCOL_VERSION }));
      return;
    }
    expect(req.headers.authorization).toBe(`Bearer ${token}`);
    const parsed = JSON.parse(await readBody(req));
    requests.push(parsed);
    await handler(parsed, req, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  const state: LocalDaemonState = {
    schema_version: 1,
    rpc_protocol_version: LOCAL_DAEMON_RPC_PROTOCOL_VERSION,
    pid: process.pid,
    port: address.port,
    token,
    started_at: new Date().toISOString(),
    home: 'test-home',
    database_path: 'test.db',
    version: '0.0.0-test',
  };
  return {
    state,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

describe('daemon-backed serve protocol', () => {
  test('callLocalDaemon preserves the legacy CLI forwarding envelope', async () => {
    const daemon = await withFakeDaemon((body, _req, res) => {
      expect(body).toEqual({ command: 'status', args: ['--json'] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stdout: '{}\n', exitCode: 0 }));
    });
    try {
      const response = await callLocalDaemon(daemon.state, { command: 'status', args: ['--json'] });
      expect(response.ok).toBe(true);
      expect(response.stdout).toBe('{}\n');
    } finally {
      await daemon.close();
    }
  });

  test('resolveDaemonBackedServeRuntime refuses alive daemons without protocol v2', async () => {
    writeDaemonState({
      schema_version: 1,
      rpc_protocol_version: 1,
      pid: process.pid,
      port: 1,
      token: 'old',
      started_at: new Date().toISOString(),
      home: 'test-home',
      database_path: 'test.db',
      version: '0.0.0-old',
    });

    const resolved = await resolveDaemonBackedServeRuntime();
    expect(resolved.kind).toBe('incompatible');
    if (resolved.kind === 'incompatible') {
      expect(resolved.reason).toContain('older than required');
    }
  });

  test('daemon-backed runtime delegates raw SQL, MCP tool calls, and queue submissions', async () => {
    const daemon = await withFakeDaemon((body, _req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (body.kind === 'raw_sql') {
        res.end(JSON.stringify({ ok: true, result: [{ ok: 1 }], exitCode: 0 }));
        return;
      }
      if (body.kind === 'tool_call') {
        expect(body.tool).toBe('whoami');
        expect(body.opts.remote).toBe(true);
        expect(body.opts.sourceId).toBe('default');
        expect(body.opts.takesHoldersAllowList).toEqual(['world']);
        expect(body.opts.auth.clientId).toBe('client-a');
        res.end(JSON.stringify({ ok: true, result: { content: [{ type: 'text', text: '{"ok":true}' }] }, exitCode: 0 }));
        return;
      }
      if (body.kind === 'queue_add') {
        expect(body.name).toBe('sync');
        expect(body.data.sourceId).toBe('default');
        expect(body.opts.maxWaiting).toBe(1);
        res.end(JSON.stringify({ ok: true, result: { id: 42, name: 'sync', status: 'waiting' }, exitCode: 0 }));
        return;
      }
      res.end(JSON.stringify({ ok: false, error: `unexpected ${body.kind}`, exitCode: 1 }));
    });

    try {
      writeDaemonState(daemon.state);
      const resolved = await resolveDaemonBackedServeRuntime();
      expect(resolved.kind).toBe('compatible');
      if (resolved.kind !== 'compatible') return;

      await expect(resolved.runtime.engine.executeRaw('SELECT 1 AS ok')).resolves.toEqual([{ ok: 1 }]);
      await expect(resolved.runtime.toolDispatcher('whoami', {}, {
        remote: true,
        sourceId: 'default',
        takesHoldersAllowList: ['world'],
        auth: { clientId: 'client-a', scopes: ['read'] } as any,
      })).resolves.toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] });
      await expect(resolved.runtime.queueAdd('sync', { sourceId: 'default' }, { maxWaiting: 1 })).resolves.toMatchObject({ id: 42, name: 'sync' });

      expect(daemon.requests.map(req => req.kind)).toEqual(['raw_sql', 'raw_sql', 'tool_call', 'queue_add']);
    } finally {
      await daemon.close();
    }
  });
});
