import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { BrainEngine } from './engine.ts';
import type { Operation, OperationContext, AuthInfo } from './operations.ts';
import { operations, OperationError } from './operations.ts';
import { serializeMarkdown } from './markdown.ts';
import { loadConfig, loadConfigWithEngine, toEngineConfig, voltmindPath } from './config.ts';
import type { VoltMindConfig } from './config.ts';
import { createEngine } from './engine-factory.ts';
import { connectWithRetry } from './db.ts';
import { configureGateway, reconfigureGatewayWithEngine } from './ai/gateway.ts';
import type { AIGatewayConfig } from './ai/types.ts';
import { getCliOptions } from './cli-options.ts';
import { awaitPendingLastRetrievedWrites } from './last-retrieved.ts';
import {
  LOCAL_DAEMON_RPC_PROTOCOL_VERSION,
  daemonStatePath,
  removeDaemonState,
  type LocalDaemonCliRequest,
  type LocalDaemonRequest,
  type LocalDaemonResponse,
  type LocalDaemonState,
} from './local-daemon.ts';
import { VERSION } from '../version.ts';
import { dispatchToolCall } from '../mcp/dispatch.ts';
import { getBrainHotMemoryMeta } from './facts/meta-hook.ts';

class DaemonCommandExit extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
    this.name = 'DaemonCommandExit';
  }
}

class ReadWriteScheduler {
  private writerTail: Promise<unknown> = Promise.resolve();
  private activeReaders = 0;

  async runRead<T>(fn: () => Promise<T>): Promise<T> {
    await this.writerTail.catch(() => undefined);
    this.activeReaders++;
    try {
      return await fn();
    } finally {
      this.activeReaders--;
    }
  }

  async runWrite<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.writerTail;
    let release!: () => void;
    this.writerTail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    while (this.activeReaders > 0) {
      await new Promise(r => setTimeout(r, 5));
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const daemonOps = new Map<string, Operation>();
for (const op of operations) {
  const cliName = op.cliHints?.name;
  if (cliName && !op.cliHints?.hidden) {
    daemonOps.set(cliName, op);
  }
}

function buildGatewayConfig(c: VoltMindConfig): AIGatewayConfig {
  const envFromConfig: Record<string, string> = {};
  if (c.openai_api_key) envFromConfig.OPENAI_API_KEY = c.openai_api_key;
  if (c.anthropic_api_key) envFromConfig.ANTHROPIC_API_KEY = c.anthropic_api_key;
  if (c.dashscope_api_key) envFromConfig.DASHSCOPE_API_KEY = c.dashscope_api_key;
  if (c.zeroentropy_api_key) envFromConfig.ZEROENTROPY_API_KEY = c.zeroentropy_api_key;

  const envBaseUrls: Record<string, string> = {};
  if (process.env.LLAMA_SERVER_BASE_URL) envBaseUrls['llama-server'] = process.env.LLAMA_SERVER_BASE_URL;
  if (process.env.LLAMA_SERVER_RERANKER_BASE_URL) envBaseUrls['llama-server-reranker'] = process.env.LLAMA_SERVER_RERANKER_BASE_URL;
  if (process.env.OLLAMA_BASE_URL) envBaseUrls['ollama'] = process.env.OLLAMA_BASE_URL;
  if (process.env.LMSTUDIO_BASE_URL) envBaseUrls['lmstudio'] = process.env.LMSTUDIO_BASE_URL;
  if (process.env.LITELLM_BASE_URL) envBaseUrls['litellm'] = process.env.LITELLM_BASE_URL;
  if (process.env.OPENROUTER_BASE_URL) envBaseUrls['openrouter'] = process.env.OPENROUTER_BASE_URL;

  return {
    embedding_model: c.embedding_model,
    embedding_dimensions: c.embedding_dimensions,
    embedding_multimodal_model: c.embedding_multimodal_model,
    expansion_model: c.expansion_model,
    chat_model: c.chat_model,
    chat_fallback_chain: c.chat_fallback_chain,
    base_urls: { ...envBaseUrls, ...(c.provider_base_urls ?? {}) },
    env: { ...envFromConfig, ...process.env },
  };
}

async function createDaemonEngine(): Promise<{ engine: BrainEngine; config: VoltMindConfig }> {
  const config = loadConfig();
  if (!config) throw new Error('No brain configured. Run: voltmind init');
  configureGateway(buildGatewayConfig(config));

  const engineConfig = toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  await connectWithRetry(engine, engineConfig, {
    noRetry: process.argv.includes('--no-retry-connect') || process.env.VOLTMIND_NO_RETRY_CONNECT === '1',
  });

  try {
    const { tryRunPendingMigrations } = await import('./migrate.ts');
    const result = await tryRunPendingMigrations(engine);
    if (result.status === 'persistent') {
      process.stderr.write('[voltmind-daemon] schema migrations are still pending; run voltmind apply-migrations --yes\n');
    } else if (result.status === 'error') {
      process.stderr.write(`[voltmind-daemon] schema probe failed: ${result.error.message}\n`);
    }
  } catch (err) {
    process.stderr.write(`[voltmind-daemon] schema probe failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  try {
    const merged = await loadConfigWithEngine(engine, config);
    if (merged) configureGateway(buildGatewayConfig(merged));
    await reconfigureGatewayWithEngine(engine);
  } catch {
    /* Older or partially initialized brains may not have DB config yet. */
  }

  return { engine, config };
}

function parseOpArgs(op: Operation, args: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const positional = op.cliHints?.positional || [];
  let posIdx = 0;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (arg.startsWith('--no-')) {
        const positiveKey = arg.slice(5).replace(/-/g, '_');
        const positiveDef = op.params[positiveKey];
        if (positiveDef?.type === 'boolean') {
          params[positiveKey] = false;
          continue;
        }
      }
      const key = arg.slice(2).replace(/-/g, '_');
      const paramDef = op.params[key];
      if (paramDef?.type === 'boolean') {
        params[key] = true;
      } else if (i + 1 < args.length) {
        params[key] = args[++i];
        if (paramDef?.type === 'number') params[key] = Number(params[key]);
      }
    } else if (posIdx < positional.length) {
      const key = positional[posIdx++];
      const paramDef = op.params[key];
      params[key] = paramDef?.type === 'number' ? Number(arg) : arg;
    }
  }
  return params;
}

async function makeContext(engine: BrainEngine, config: VoltMindConfig, params: Record<string, unknown>): Promise<OperationContext> {
  let sourceId: string | undefined;
  try {
    const { resolveSourceId } = await import('./source-resolver.ts');
    sourceId = await resolveSourceId(engine, (params.source as string | undefined) ?? null);
  } catch {
    sourceId = undefined;
  }
  return {
    engine,
    config,
    logger: { info: console.log, warn: console.warn, error: console.error },
    dryRun: (params.dry_run as boolean) || false,
    remote: false,
    cliOpts: getCliOptions(),
    sourceId: sourceId ?? 'default',
  };
}

function formatOperationResult(opName: string, result: unknown): string {
  switch (opName) {
    case 'get_page': {
      const r = result as any;
      if (r.error === 'ambiguous_slug') {
        return `Ambiguous slug. Did you mean:\n${r.candidates.map((c: string) => `  ${c}`).join('\n')}\n`;
      }
      return serializeMarkdown(r.frontmatter || {}, r.compiled_truth || '', r.timeline || '', {
        type: r.type, title: r.title, tags: r.tags || [],
      });
    }
    case 'list_pages': {
      const pages = result as any[];
      if (pages.length === 0) return 'No pages found.\n';
      return pages.map(p =>
        `${p.slug}\t${p.type}\t${p.updated_at?.toString().slice(0, 10) || '?'}\t${p.title}`,
      ).join('\n') + '\n';
    }
    case 'search':
    case 'query': {
      const results = result as any[];
      if (results.length === 0) return 'No results.\n';
      return results.map(r =>
        `[${r.score?.toFixed(4) || '?'}] ${r.slug} -- ${r.chunk_text?.slice(0, 100) || ''}${r.stale ? ' (stale)' : ''}`,
      ).join('\n') + '\n';
    }
    case 'get_stats': {
      const s = result as any;
      const lines = [
        `Pages:     ${s.page_count}`,
        `Chunks:    ${s.chunk_count}`,
        `Embedded:  ${s.embedded_count}`,
        `Links:     ${s.link_count}`,
        `Tags:      ${s.tag_count}`,
        `Timeline:  ${s.timeline_entry_count}`,
      ];
      return lines.join('\n') + '\n';
    }
    case 'get_health':
      return JSON.stringify(result, null, 2) + '\n';
    default:
      return result === undefined ? '' : JSON.stringify(result, null, 2) + '\n';
  }
}

async function runOperation(engine: BrainEngine, config: VoltMindConfig, command: string, args: string[]): Promise<string> {
  const op = daemonOps.get(command);
  if (!op) throw new Error(`Daemon cannot route operation command: ${command}`);
  const params = parseOpArgs(op, args);
  for (const [key, def] of Object.entries(op.params)) {
    if (def.required && params[key] === undefined) {
      const cliName = op.cliHints?.name || op.name;
      const positional = op.cliHints?.positional || [];
      const usage = positional.map(p => `<${p}>`).join(' ');
      throw new Error(`Usage: voltmind ${cliName} ${usage}`);
    }
  }
  const ctx = await makeContext(engine, config, params);
  const result = await op.handler(ctx, params);
  const output = formatOperationResult(op.name, JSON.parse(JSON.stringify(result)));
  if (op.name === 'query') {
    const { awaitPendingSearchCacheWrites } = await import('./search/hybrid.ts');
    await awaitPendingSearchCacheWrites();
  }
  await awaitPendingLastRetrievedWrites();
  return output;
}

async function runCommand(engine: BrainEngine, config: VoltMindConfig, req: LocalDaemonCliRequest): Promise<number> {
  const command = req.command === 'ask' ? 'query' : req.command;
  const args = req.args || [];
  switch (command) {
    case 'import': {
      const { runImport } = await import('../commands/import.ts');
      const result = await runImport(engine, args);
      return result.errors > 0 ? 1 : 0;
    }
    case 'capture': {
      const { runCapture } = await import('../commands/capture.ts');
      await runCapture(engine, args);
      return 0;
    }
    case 'sync': {
      const { runSync } = await import('../commands/sync.ts');
      await runSync(engine, args);
      return 0;
    }
    case 'embed': {
      const { runEmbed } = await import('../commands/embed.ts');
      await runEmbed(engine, args);
      return 0;
    }
    case 'status': {
      const { runStatus } = await import('../commands/status.ts');
      const result = await runStatus(engine, args);
      return result.exitCode;
    }
    case 'config': {
      const { runConfig } = await import('../commands/config.ts');
      await runConfig(engine, args);
      return 0;
    }
    case 'sources': {
      const { runSources } = await import('../commands/sources.ts');
      await runSources(engine, args);
      return 0;
    }
    case 'actions': {
      const { runActions } = await import('../commands/actions.ts');
      await runActions(engine, args);
      return 0;
    }
    case 'search': {
      if (['modes', 'stats', 'tune'].includes(args[0] || '')) {
        const { runSearch } = await import('../commands/search.ts');
        await runSearch(engine, args);
        return 0;
      }
      process.stdout.write(await runOperation(engine, config, command, args));
      return 0;
    }
    default:
      process.stdout.write(await runOperation(engine, config, command, args));
      return 0;
  }
}

function isStructuredRequest(req: LocalDaemonRequest): req is Extract<LocalDaemonRequest, { kind: string }> {
  return typeof (req as { kind?: unknown }).kind === 'string';
}

function isCliRequest(req: LocalDaemonRequest): req is LocalDaemonCliRequest {
  return typeof (req as { command?: unknown }).command === 'string';
}

function isReadOnlySql(sql: string): boolean {
  const normalized = sql.trim().replace(/^\/\*[\s\S]*?\*\//, '').trim().toUpperCase();
  if (!normalized) return false;
  if (normalized.startsWith('SELECT') || normalized.startsWith('SHOW')) return true;
  if (normalized.startsWith('WITH')) {
    return !/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|REINDEX|VACUUM)\b/.test(normalized);
  }
  return false;
}

function isParallelReadRequest(req: LocalDaemonRequest): boolean {
  if (isStructuredRequest(req)) {
    if (req.kind === 'raw_sql') return isReadOnlySql(req.sql);
    if (req.kind === 'engine_stats' || req.kind === 'engine_health') return true;
    if (req.kind === 'tool_call') {
      const op = operations.find(o => o.name === req.tool);
      return Boolean(op && op.scope === 'read');
    }
    return false;
  }
  const command = req.command === 'ask' ? 'query' : req.command;
  if (command === 'search' && ['modes', 'stats', 'tune'].includes(req.args?.[0] || '')) return false;
  return ['get', 'list', 'search', 'query', 'tags', 'backlinks', 'graph', 'timeline', 'stats', 'health'].includes(command);
}

async function runParallelReadOperation(
  engine: BrainEngine,
  config: VoltMindConfig,
  req: LocalDaemonCliRequest,
): Promise<LocalDaemonResponse> {
  try {
    const stdout = await runOperation(engine, config, req.command, req.args || []);
    return { ok: true, stdout, exitCode: 0 };
  } catch (err) {
    if (err instanceof OperationError) {
      return {
        ok: false,
        stderr: `Error [${err.code}]: ${err.message}${err.suggestion ? `\n  Fix: ${err.suggestion}` : ''}\n`,
        exitCode: 1,
      };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err), exitCode: 1 };
  }
}

async function runStructuredRequest(engine: BrainEngine, req: Extract<LocalDaemonRequest, { kind: string }>): Promise<LocalDaemonResponse> {
  try {
    switch (req.kind) {
      case 'tool_call': {
        const result = await dispatchToolCall(engine, req.tool, req.params, {
          remote: req.opts?.remote ?? true,
          takesHoldersAllowList: req.opts?.takesHoldersAllowList,
          sourceId: req.opts?.sourceId,
          auth: req.opts?.auth as AuthInfo | undefined,
          metaHook: getBrainHotMemoryMeta,
          logger: {
            info: (msg: string) => process.stderr.write(`[INFO] ${msg}\n`),
            warn: (msg: string) => process.stderr.write(`[WARN] ${msg}\n`),
            error: (msg: string) => process.stderr.write(`[ERROR] ${msg}\n`),
          },
        });
        return { ok: true, result, exitCode: 0 };
      }
      case 'raw_sql': {
        const result = await engine.executeRaw(req.sql, req.params ?? []);
        return { ok: true, result, exitCode: 0 };
      }
      case 'engine_stats': {
        return { ok: true, result: await engine.getStats(), exitCode: 0 };
      }
      case 'engine_health': {
        return { ok: true, result: await engine.getHealth(), exitCode: 0 };
      }
      case 'queue_add': {
        const { MinionQueue } = await import('./minions/queue.ts');
        const queue = new MinionQueue(engine);
        const result = await queue.add(req.name, req.data, req.opts as any, req.trusted);
        return { ok: true, result: JSON.parse(JSON.stringify(result)), exitCode: 0 };
      }
      default: {
        const neverReq: never = req;
        return { ok: false, error: `unknown structured daemon request: ${(neverReq as any).kind}`, exitCode: 1 };
      }
    }
  } catch (err) {
    if (err instanceof OperationError) {
      return {
        ok: false,
        stderr: `Error [${err.code}]: ${err.message}${err.suggestion ? `\n  Fix: ${err.suggestion}` : ''}\n`,
        exitCode: 1,
      };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err), exitCode: 1 };
  }
}

async function captureCommand(fn: () => Promise<number>): Promise<LocalDaemonResponse> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalExit = process.exit;
  let stdout = '';
  let stderr = '';
  (process.stdout as any).write = (chunk: unknown, encoding?: unknown, cb?: unknown) => {
    stdout += Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding as BufferEncoding : 'utf-8') : String(chunk);
    if (typeof encoding === 'function') encoding();
    if (typeof cb === 'function') cb();
    return true;
  };
  (process.stderr as any).write = (chunk: unknown, encoding?: unknown, cb?: unknown) => {
    stderr += Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding as BufferEncoding : 'utf-8') : String(chunk);
    if (typeof encoding === 'function') encoding();
    if (typeof cb === 'function') cb();
    return true;
  };
  (process as any).exit = (code?: number) => {
    throw new DaemonCommandExit(typeof code === 'number' ? code : 0);
  };
  try {
    const exitCode = await fn();
    return { ok: exitCode === 0, stdout, stderr, exitCode };
  } catch (err) {
    if (err instanceof DaemonCommandExit) {
      return { ok: err.code === 0, stdout, stderr, exitCode: err.code };
    }
    if (err instanceof OperationError) {
      const msg = `Error [${err.code}]: ${err.message}${err.suggestion ? `\n  Fix: ${err.suggestion}` : ''}`;
      return { ok: false, stdout, stderr: stderr + msg + '\n', exitCode: 1 };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, stdout, stderr, error: msg, exitCode: 1 };
  } finally {
    (process.stdout as any).write = originalStdoutWrite;
    (process.stderr as any).write = originalStderrWrite;
    (process as any).exit = originalExit;
  }
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error('Request body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export async function runLocalDaemonServer(): Promise<void> {
  process.env.VOLTMIND_DAEMON_BYPASS = '1';
  const { engine, config } = await createDaemonEngine();
  const engineConfig = toEngineConfig(config);
  const token = randomBytes(24).toString('hex');
  let shuttingDown = false;

  const scheduler = new ReadWriteScheduler();
  const actionScanner = setInterval(() => {
    void scheduler.runWrite(async () => {
      try {
        const { scanActions, listActions, runAction, updateActionStatus } = await import('./actions.ts');
        await scanActions(engine);
        const due = await listActions(engine, { status: 'on_schedule', dueOnly: true, limit: 25 });
        for (const action of due) {
          const gateReady =
            action.eligible &&
            action.status === 'on_schedule' &&
            ['low', 'medium'].includes(action.risk_level) &&
            (action.risk_level !== 'medium' || Boolean(action.approved_at));
          if (!gateReady) continue;
          await updateActionStatus(engine, action.slug, 'in_progress', {
            sourceId: action.source_id,
            note: 'Scheduled execution started.',
          });
          await runAction(engine, action.slug, {
            sourceId: action.source_id,
            execute: true,
            confirmed: true,
          });
        }
      } catch (err) {
        process.stderr.write(`[voltmind-daemon] action scan failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }).catch((err) => {
      process.stderr.write(`[voltmind-daemon] action scan scheduler failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  }, 60_000);
  actionScanner.unref?.();

  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/health' && req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          version: VERSION,
          rpc_protocol_version: LOCAL_DAEMON_RPC_PROTOCOL_VERSION,
        });
        return;
      }
      if (req.url !== '/rpc' || req.method !== 'POST') {
        sendJson(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${token}`) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      const parsed = JSON.parse(await readRequestBody(req)) as LocalDaemonRequest;
      if (isCliRequest(parsed) && parsed.command === '__shutdown') {
        shuttingDown = true;
        sendJson(res, 200, { ok: true, stdout: 'VoltMind daemon stopping.\n', exitCode: 0 });
        void shutdown();
        return;
      }
      const response = isParallelReadRequest(parsed)
        ? await scheduler.runRead(() => (
          isStructuredRequest(parsed)
            ? runStructuredRequest(engine, parsed)
            : runParallelReadOperation(engine, config, parsed)
        ))
        : await scheduler.runWrite(() => (
          isStructuredRequest(parsed)
            ? runStructuredRequest(engine, parsed)
            : captureCommand(() => runCommand(engine, config, parsed))
        ));
      sendJson(res, 200, response);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err), exitCode: 1 });
    }
  });

  async function shutdown(): Promise<void> {
    clearInterval(actionScanner);
    server.close();
    await scheduler.runWrite(async () => undefined).catch(() => undefined);
    try { await engine.disconnect(); } catch { /* best-effort */ }
    removeDaemonState();
    if (shuttingDown) process.exit(0);
  }

  process.on('SIGTERM', () => { shuttingDown = true; void shutdown(); });
  process.on('SIGHUP', () => { shuttingDown = true; void shutdown(); });
  process.on('SIGINT', () => { shuttingDown = true; void shutdown(); });
  process.on('exit', () => removeDaemonState());

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind local daemon port');

  const state: LocalDaemonState = {
    schema_version: 1,
    rpc_protocol_version: LOCAL_DAEMON_RPC_PROTOCOL_VERSION,
    pid: process.pid,
    port: address.port,
    token,
    started_at: new Date().toISOString(),
    home: voltmindPath(''),
    database_path: engineConfig.engine === 'pglite' ? engineConfig.database_path : undefined,
    version: VERSION,
  };
  mkdirSync(dirname(daemonStatePath()), { recursive: true });
  writeFileSync(daemonStatePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
  process.stderr.write(`VoltMind daemon listening on 127.0.0.1:${address.port} (pid ${process.pid})\n`);
}
