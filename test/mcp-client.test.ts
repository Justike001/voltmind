/**
 * Tests for src/core/mcp-client.ts.
 *
 * Strategy: spin up an in-process HTTP server that mimics voltmind serve --http
 * (OAuth discovery + /token + /mcp). Test callRemoteTool against it,
 * including the OAuth token cache, the 401 → refresh-once retry, and the
 * RemoteMcpError shape.
 *
 * The /mcp fixture implements just enough JSON-RPC to satisfy
 * StreamableHTTPClientTransport's connect handshake (initialize + initialized
 * notification) plus tools/call. NOT a full MCP server — only the surface
 * area a client_credentials thin-client uses.
 *
 * Async Bun.spawn-friendly: the test event loop stays responsive during
 * fetch round-trips because callRemoteTool awaits async work properly.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import {
  callRemoteTool,
  unpackToolResult,
  RemoteMcpError,
  _clearMcpClientTokenCache,
} from '../src/core/mcp-client.ts';
import type { VoltMindConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

let server: Server;
let port: number;

// Per-test response control
let tokenStatus = 200;
let mcpResponseFor: (req: { method: string; params?: unknown }) => unknown = () => ({});
let mcpStatusOverride: number | null = null;
let mcpRejectRemaining = 0;
let mcpRequestCount = 0;
let tokenMintCount = 0;
let tokenResources: Array<string | null> = [];
let tokenError = 'invalid_client';
let discoveryDelayMs = 0;
let tokenDelayMs = 0;
let revokeClientOnMcp401 = false;

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/.well-known/oauth-authorization-server') {
      if (discoveryDelayMs > 0) await new Promise(resolve => setTimeout(resolve, discoveryDelayMs));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ token_endpoint: `http://127.0.0.1:${port}/token`, issuer: `http://127.0.0.1:${port}/` }));
      return;
    }
    if (req.url === '/token') {
      if (tokenDelayMs > 0) await new Promise(resolve => setTimeout(resolve, tokenDelayMs));
      tokenMintCount++;
      res.statusCode = tokenStatus;
      res.setHeader('Content-Type', 'application/json');
      if (tokenStatus === 200) {
        const chunks: Buffer[] = [];
        try {
          for await (const chunk of req) chunks.push(chunk as Buffer);
        } catch {
          return;
        }
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf-8'));
        tokenResources.push(form.get('resource'));
        res.end(JSON.stringify({
          access_token: `token-${form.get('client_id')}-${form.get('client_secret')}-${tokenMintCount}`,
          token_type: 'bearer',
          expires_in: 3600,
          scope: 'read write admin',
        }));
      } else {
        res.end(JSON.stringify({ error: tokenError }));
      }
      return;
    }
    if (req.url === '/mcp' && req.method === 'POST') {
      mcpRequestCount++;
      if (mcpRejectRemaining > 0) {
        mcpRejectRemaining--;
        if (revokeClientOnMcp401) {
          tokenStatus = 400;
          tokenError = 'invalid_grant';
        }
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
        res.end();
        return;
      }
      // Test-controlled status override (used to simulate 401 from MCP).
      if (mcpStatusOverride !== null) {
        res.statusCode = mcpStatusOverride;
        res.end();
        return;
      }
      // Read JSON-RPC body
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of req) chunks.push(chunk as Buffer);
      } catch {
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      const isNotification = body.id === undefined;
      // Notifications get 202 No Content
      if (isNotification) {
        res.statusCode = 202;
        res.end();
        return;
      }
      let result: unknown;
      if (body.method === 'initialize') {
        result = {
          protocolVersion: body.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mcp-client-test-fixture', version: '1' },
        };
      } else if (body.method === 'tools/call') {
        result = mcpResponseFor({ method: body.method, params: body.params });
      } else {
        result = {};
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind fixture');
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  tokenStatus = 200;
  tokenMintCount = 0;
  tokenResources = [];
  mcpStatusOverride = null;
  mcpRejectRemaining = 0;
  mcpRequestCount = 0;
  mcpResponseFor = () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] });
  tokenError = 'invalid_client';
  discoveryDelayMs = 0;
  tokenDelayMs = 0;
  revokeClientOnMcp401 = false;
  _clearMcpClientTokenCache();
});

function makeConfig(): VoltMindConfig {
  return {
    engine: 'postgres',
    remote_mcp: {
      issuer_url: `http://127.0.0.1:${port}`,
      mcp_url: `http://127.0.0.1:${port}/mcp`,
      oauth_client_id: 'cid',
      oauth_client_secret: 'csecret',
    },
  };
}

describe('callRemoteTool — happy path', () => {
  test('returns the tool response for a simple call', async () => {
    mcpResponseFor = () => ({ content: [{ type: 'text', text: JSON.stringify({ greeting: 'hello' }) }] });
    const res = await callRemoteTool(makeConfig(), 'echo', {});
    const parsed = unpackToolResult<{ greeting: string }>(res);
    expect(parsed.greeting).toBe('hello');
    expect(tokenResources).toEqual([`http://127.0.0.1:${port}/mcp`]);
  });

  test('caches the access token across multiple calls', async () => {
    await callRemoteTool(makeConfig(), 'noop', {});
    expect(tokenMintCount).toBe(1);
    await callRemoteTool(makeConfig(), 'noop', {});
    expect(tokenMintCount).toBe(1); // still 1 — cache was reused
    await callRemoteTool(makeConfig(), 'noop', {});
    expect(tokenMintCount).toBe(1);
  });

  test('does not reuse a cached token across client identity or secret rotation', async () => {
    const first = makeConfig();
    await callRemoteTool(first, 'noop', {});
    const second = makeConfig();
    second.remote_mcp!.oauth_client_id = 'other-client';
    await callRemoteTool(second, 'noop', {});
    const rotated = makeConfig();
    rotated.remote_mcp!.oauth_client_secret = 'rotated-secret';
    await callRemoteTool(rotated, 'noop', {});
    expect(tokenMintCount).toBe(3);
  });

  test('passes args through to the tool handler', async () => {
    let captured: unknown = null;
    mcpResponseFor = ({ params }) => {
      captured = params;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    };
    await callRemoteTool(makeConfig(), 'with_args', { foo: 'bar', n: 42 });
    expect(captured).toEqual({ name: 'with_args', arguments: { foo: 'bar', n: 42 } });
  });
});

describe('callRemoteTool — 401 refresh-on-once', () => {
  test('401 from /mcp → re-mint token + retry succeeds', async () => {
    mcpRejectRemaining = 1;
    await callRemoteTool(makeConfig(), 'after_401', {});
    expect(tokenMintCount).toBe(2);
    expect(mcpRequestCount).toBe(4); // rejected init + init + initialized notification + tools/call
  });

  test('second 401 becomes auth_after_refresh and never makes a third attempt', async () => {
    mcpRejectRemaining = 2;
    try {
      await callRemoteTool(makeConfig(), 'still_unauthorized', {});
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteMcpError);
      expect((error as RemoteMcpError).reason).toBe('auth_after_refresh');
    }
    expect(tokenMintCount).toBe(2);
    expect(mcpRequestCount).toBe(2);
  });

  test('revoked client during 401 refresh is classified explicitly', async () => {
    mcpRejectRemaining = 1;
    revokeClientOnMcp401 = true;
    try {
      await callRemoteTool(makeConfig(), 'revoked_client', {});
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteMcpError);
      expect((error as RemoteMcpError).reason).toBe('auth_after_refresh');
      expect((error as RemoteMcpError).detail?.code).toBe('invalid_grant');
      expect((error as Error).message).toContain('invalid or revoked');
    }
    expect(mcpRequestCount).toBe(1);
    expect(tokenMintCount).toBe(2);
  });
});

describe('callRemoteTool — error surfaces', () => {
  test('config has no remote_mcp → throws RemoteMcpError(config)', async () => {
    await expect(callRemoteTool({ engine: 'postgres' }, 'foo', {})).rejects.toThrow(RemoteMcpError);
  });

  test('client_secret missing → throws RemoteMcpError(config)', async () => {
    const config: VoltMindConfig = {
      engine: 'postgres',
      remote_mcp: {
        issuer_url: `http://127.0.0.1:${port}`,
        mcp_url: `http://127.0.0.1:${port}/mcp`,
        oauth_client_id: 'cid',
      },
    };
    await withEnv({ VOLTMIND_REMOTE_CLIENT_SECRET: undefined }, async () => {
      try {
        await callRemoteTool(config, 'foo', {});
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(RemoteMcpError);
        expect((e as RemoteMcpError).reason).toBe('config');
      }
    });
  });

  test('token mint fails with 401 → throws RemoteMcpError(auth)', async () => {
    tokenStatus = 401;
    try {
      await callRemoteTool(makeConfig(), 'foo', {});
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteMcpError);
      expect((e as RemoteMcpError).reason).toBe('auth');
    }
  });

  test('rejects an untrusted MCP origin before minting or sending a token', async () => {
    const config = makeConfig();
    config.remote_mcp!.mcp_url = 'https://attacker.example/mcp';
    try {
      await callRemoteTool(config, 'foo', {});
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteMcpError);
      expect((e as RemoteMcpError).reason).toBe('config');
      expect((e as Error).message).not.toContain('csecret');
    }
    expect(tokenMintCount).toBe(0);
  });

  test('allows an explicitly configured cross-origin MCP endpoint', async () => {
    const config = makeConfig();
    config.remote_mcp!.mcp_url = `http://localhost:${port}/mcp`;
    config.remote_mcp!.mcp_endpoint_allowed_origins = [`http://localhost:${port}`];
    await callRemoteTool(config, 'noop', {});
    expect(tokenMintCount).toBe(1);
    expect(tokenResources).toEqual([`http://localhost:${port}/mcp`]);
  });

  test('invalid_grant from token endpoint is classified as credential auth failure', async () => {
    tokenStatus = 400;
    tokenError = 'invalid_grant';
    try {
      await callRemoteTool(makeConfig(), 'foo', {});
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteMcpError);
      expect((e as RemoteMcpError).reason).toBe('auth');
      expect((e as RemoteMcpError).detail?.code).toBe('invalid_grant');
      expect((e as Error).message).toContain('invalid or revoked');
    }
  });

  test('one deadline aborts during OAuth discovery as timeout', async () => {
    discoveryDelayMs = 100;
    try {
      await callRemoteTool(makeConfig(), 'foo', {}, { timeoutMs: 20 });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteMcpError);
      expect((e as RemoteMcpError).detail?.kind).toBe('timeout');
    }
    expect(tokenMintCount).toBe(0);
  });

  test('one deadline aborts during token mint as timeout', async () => {
    tokenDelayMs = 100;
    try {
      await callRemoteTool(makeConfig(), 'foo', {}, { timeoutMs: 20 });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteMcpError);
      expect((e as RemoteMcpError).detail?.kind).toBe('timeout');
    }
  });

  test('external abort remains aborted rather than timeout', async () => {
    discoveryDelayMs = 100;
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('SIGINT')), 20);
    try {
      await callRemoteTool(makeConfig(), 'foo', {}, { signal: controller.signal, timeoutMs: 1000 });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteMcpError);
      expect((e as RemoteMcpError).detail?.kind).toBe('aborted');
    }
  });

  test('discovery URL unreachable → throws RemoteMcpError(network)', async () => {
    const config: VoltMindConfig = {
      engine: 'postgres',
      remote_mcp: {
        issuer_url: 'http://127.0.0.1:1', // typically refused
        mcp_url: 'http://127.0.0.1:1/mcp',
        oauth_client_id: 'cid',
        oauth_client_secret: 'csecret',
      },
    };
    try {
      await callRemoteTool(config, 'foo', {});
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteMcpError);
      expect((e as RemoteMcpError).reason).toBe('network');
    }
  });

  test('tool returns isError → throws RemoteMcpError(tool_error)', async () => {
    mcpResponseFor = () => ({
      content: [{ type: 'text', text: 'something went wrong' }],
      isError: true,
    });
    try {
      await callRemoteTool(makeConfig(), 'fails', {});
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteMcpError);
      expect((e as RemoteMcpError).reason).toBe('tool_error');
    }
  });
});

describe('unpackToolResult', () => {
  test('extracts JSON from the first content text element', () => {
    const wire = { content: [{ type: 'text', text: JSON.stringify({ a: 1, b: 'two' }) }] };
    expect(unpackToolResult<{ a: number; b: string }>(wire)).toEqual({ a: 1, b: 'two' });
  });

  test('throws RemoteMcpError(parse) on non-JSON text', () => {
    const wire = { content: [{ type: 'text', text: 'not json' }] };
    expect(() => unpackToolResult(wire)).toThrow(RemoteMcpError);
  });

  test('throws RemoteMcpError(parse) on missing content array', () => {
    expect(() => unpackToolResult({})).toThrow(RemoteMcpError);
  });

  test('throws RemoteMcpError(parse) on wrong content type', () => {
    const wire = { content: [{ type: 'image', data: 'xxx' }] };
    expect(() => unpackToolResult(wire)).toThrow(RemoteMcpError);
  });
});
