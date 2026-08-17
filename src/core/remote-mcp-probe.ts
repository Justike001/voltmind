/**
 * Outbound HTTP probes for thin-client mode (multi-topology v1).
 *
 * Three pure functions covering the discovery + auth + smoke surface that
 * `voltmind init --mcp-only` and the thin-client doctor both need. No SDK
 * dependency; just `fetch`. Lane B's `src/core/mcp-client.ts` builds on
 * these helpers (or supersedes them with the official SDK Client) but for
 * Lane A's setup-flow smoke test, raw HTTP keeps the scope tight and avoids
 * pulling the streamableHttp transport into the init path.
 *
 * Each function returns a discriminated `{ok: true, ...}` / `{ok: false, error}`
 * so callers can render the error reason consistently. Network errors surface
 * as `network` reason; HTTP non-2xx surfaces as `http` with status. Auth
 * errors get their own `auth` reason for clean rendering.
 */

import {
  validateOAuthIssuerUrl,
  validateOAuthMetadataEndpoints,
  validateRemoteMcpUrl,
  type OAuthEndpointValidationOptions,
  type RemoteMcpEndpointValidationOptions,
} from './oauth-url-validation.ts';

export type ProbeFailureReason =
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'http'
  | 'auth'
  | 'parse'
  | 'config';

export type ProbeResult<T = void> =
  | { ok: true } & ({} extends T ? unknown : T extends void ? unknown : { value: T })
  | { ok: false; reason: ProbeFailureReason; status?: number; code?: string; message: string };

export interface ProbeRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

function probeSignal(opts: ProbeRequestOptions, defaultTimeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  if (opts.signal && opts.timeoutMs === undefined) {
    return { signal: opts.signal, cleanup: () => {}, timedOut: () => false };
  }
  const controller = new AbortController();
  let didTimeout = false;
  const onAbort = () => controller.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
  const timer = timeoutMs > 0
    ? setTimeout(() => {
        didTimeout = true;
        controller.abort(new Error(`timeout after ${timeoutMs}ms`));
      }, timeoutMs)
    : undefined;
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    },
    timedOut: () => didTimeout,
  };
}

/** Compose one caller-owned deadline for a discovery → token → MCP probe. */
export function createRemoteProbeDeadline(
  opts: ProbeRequestOptions = {},
  defaultTimeoutMs = 30_000,
): { signal: AbortSignal; cleanup: () => void } {
  const request = probeSignal(opts, defaultTimeoutMs);
  return { signal: request.signal, cleanup: request.cleanup };
}

function probeCaught(
  stage: string,
  error: unknown,
  signal: AbortSignal,
  timedOut: boolean,
): { ok: false; reason: 'network' | 'timeout' | 'aborted'; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (timedOut || (signal.aborted && /timeout/i.test(String(signal.reason)))) {
    return { ok: false, reason: 'timeout', message: `${stage} timed out` };
  }
  if (signal.aborted) {
    return { ok: false, reason: 'aborted', message: `${stage} aborted` };
  }
  return { ok: false, reason: 'network', message: `${stage} network error: ${message}` };
}

/**
 * GET <issuer_url>/.well-known/oauth-authorization-server. Verifies the
 * server reachable AND speaking OAuth before we hand it credentials.
 * Returns the parsed metadata (token_endpoint etc) on success so callers
 * don't have to re-hit the endpoint.
 */
export interface OAuthMetadata {
  token_endpoint: string;
  issuer?: string;
  scopes_supported?: string[];
  // The server may return many more fields; we only care about token_endpoint
  // for the credentials flow. Carry the rest through for diagnostics.
  [key: string]: unknown;
}

export async function discoverOAuth(
  issuerUrl: string,
  opts: ProbeRequestOptions & OAuthEndpointValidationOptions = {},
): Promise<{ ok: true; metadata: OAuthMetadata } | { ok: false; reason: ProbeFailureReason; status?: number; message: string }> {
  const trimmed = issuerUrl.replace(/\/+$/, '');
  const issuerValidation = validateOAuthIssuerUrl(trimmed, opts);
  if (!issuerValidation.ok) {
    return { ok: false, reason: 'config', message: issuerValidation.message };
  }
  const url = `${trimmed}/.well-known/oauth-authorization-server`;
  const request = probeSignal(opts, 10_000);
  try {
    const res = await fetch(url, { signal: request.signal });
    if (!res.ok) {
      return { ok: false, reason: 'http', status: res.status, message: `OAuth discovery returned ${res.status} for ${url}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      return { ok: false, reason: 'parse', message: `OAuth discovery returned non-JSON body: ${(e as Error).message}` };
    }
    if (!body || typeof body !== 'object') {
      return { ok: false, reason: 'parse', message: `OAuth discovery returned an invalid metadata object at ${url}` };
    }
    if (typeof (body as OAuthMetadata).issuer !== 'string') {
      return { ok: false, reason: 'parse', message: `OAuth discovery missing issuer at ${url}` };
    }
    if (typeof (body as OAuthMetadata).token_endpoint !== 'string') {
      return { ok: false, reason: 'parse', message: `OAuth discovery missing token_endpoint at ${url}` };
    }
    const validation = validateOAuthMetadataEndpoints(trimmed, body as OAuthMetadata, opts);
    if (!validation.ok) {
      return { ok: false, reason: 'config', message: validation.message };
    }
    return {
      ok: true,
      metadata: { ...(body as OAuthMetadata), token_endpoint: validation.value.tokenEndpoint.href },
    };
  } catch (e) {
    return probeCaught('OAuth discovery', e, request.signal, request.timedOut());
  } finally {
    request.cleanup();
  }
}

/**
 * POST <token_endpoint> with grant_type=client_credentials. Returns the
 * access_token + expires_in on success. 401 → reason=auth; other non-2xx
 * → reason=http; network → reason=network.
 */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
}

export async function mintClientCredentialsToken(
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string,
  opts: ProbeRequestOptions & { scope?: string; resource?: URL } = {},
): Promise<{ ok: true; token: TokenResponse } | { ok: false; reason: ProbeFailureReason; status?: number; code?: string; message: string }> {
  if (!clientId) return { ok: false, reason: 'config', message: 'client_id is required' };
  if (!clientSecret) return { ok: false, reason: 'config', message: 'client_secret is required' };

  const body = new URLSearchParams();
  body.set('grant_type', 'client_credentials');
  body.set('client_id', clientId);
  body.set('client_secret', clientSecret);
  if (opts.scope) body.set('scope', opts.scope);
  // RFC 8707: bind the token to the exact protected MCP resource.  This is
  // intentionally the complete endpoint URL (including any public path), not
  // merely the OAuth issuer origin.
  if (opts.resource) body.set('resource', opts.resource.href);

  const request = probeSignal(opts, 10_000);
  try {
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: request.signal,
    });
    if (!res.ok) {
      let oauthError: string | undefined;
      try {
        const errorBody = await res.json() as { error?: unknown };
        if (typeof errorBody?.error === 'string') oauthError = errorBody.error;
      } catch { /* non-JSON error body */ }
      if (res.status === 401 || res.status === 403 || oauthError === 'invalid_client' || oauthError === 'invalid_grant') {
        const revoked = oauthError === 'invalid_grant' ? ' — client credential is invalid or revoked' : ' — check client_id and client_secret';
        return { ok: false, reason: 'auth', status: res.status, ...(oauthError ? { code: oauthError } : {}), message: `OAuth /token returned ${oauthError ?? res.status}${revoked}` };
      }
      return { ok: false, reason: 'http', status: res.status, message: `OAuth /token returned ${res.status}` };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      return { ok: false, reason: 'parse', message: `OAuth /token returned non-JSON: ${(e as Error).message}` };
    }
    if (!json || typeof json !== 'object' || typeof (json as TokenResponse).access_token !== 'string') {
      return { ok: false, reason: 'parse', message: `OAuth /token response missing access_token` };
    }
    return { ok: true, token: json as TokenResponse };
  } catch (e) {
    return probeCaught('OAuth /token', e, request.signal, request.timedOut());
  } finally {
    request.cleanup();
  }
}

/**
 * Smoke-test the MCP endpoint with an `initialize` JSON-RPC call. Verifies
 * (a) the URL is reachable, (b) the bearer token is accepted, (c) the
 * server actually speaks MCP. Cheaper than `tools/list` and doesn't require
 * a particular tool to exist. Used by init smoke + thin-client doctor.
 *
 * Note: This is a one-shot probe, not a long-lived session. We don't follow
 * up with `notifications/initialized` because we tear down immediately.
 * Servers that strictly require the full handshake will reject; voltmind's
 * own `serve --http` accepts the bare initialize request and returns
 * server info, which is exactly what we want for a connectivity check.
 */
export async function smokeTestMcp(
  mcpUrl: string,
  accessToken: string,
  opts: ProbeRequestOptions & RemoteMcpEndpointValidationOptions & { issuerUrl: string },
): Promise<{ ok: true } | { ok: false; reason: ProbeFailureReason; status?: number; message: string }> {
  const endpointValidation = validateRemoteMcpUrl(opts.issuerUrl, mcpUrl, opts);
  if (!endpointValidation.ok) {
    return { ok: false, reason: 'config', message: endpointValidation.message };
  }
  const request = probeSignal(opts, 15_000);
  try {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'voltmind-init-smoke', version: '1' },
        },
      }),
      signal: request.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'auth', status: res.status, message: `MCP smoke returned ${res.status} — token rejected at ${mcpUrl}` };
    }
    if (!res.ok) {
      return { ok: false, reason: 'http', status: res.status, message: `MCP smoke returned ${res.status} from ${mcpUrl}` };
    }
    const raw = await res.text();
    const candidates: unknown[] = [];
    if ((res.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
      for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { candidates.push(JSON.parse(data)); } catch { /* try remaining events */ }
      }
    } else {
      try { candidates.push(JSON.parse(raw)); } catch {
        return { ok: false, reason: 'parse', message: `MCP smoke returned non-JSON/non-SSE content from ${mcpUrl}` };
      }
    }
    const response = candidates.find(candidate => {
      if (!candidate || typeof candidate !== 'object') return false;
      const envelope = candidate as Record<string, unknown>;
      return envelope.jsonrpc === '2.0' && envelope.id === 1;
    }) as Record<string, unknown> | undefined;
    const result = response?.result;
    if (!result || typeof result !== 'object') {
      return { ok: false, reason: 'parse', message: `MCP initialize response missing JSON-RPC result from ${mcpUrl}` };
    }
    const initialize = result as Record<string, unknown>;
    const serverInfo = initialize.serverInfo;
    if (
      typeof initialize.protocolVersion !== 'string'
      || !initialize.protocolVersion
      || !initialize.capabilities
      || typeof initialize.capabilities !== 'object'
      || !serverInfo
      || typeof serverInfo !== 'object'
      || typeof (serverInfo as Record<string, unknown>).name !== 'string'
      || typeof (serverInfo as Record<string, unknown>).version !== 'string'
    ) {
      return { ok: false, reason: 'parse', message: `MCP initialize response has an invalid result shape from ${mcpUrl}` };
    }
    return { ok: true };
  } catch (e) {
    return probeCaught('MCP smoke', e, request.signal, request.timedOut());
  } finally {
    request.cleanup();
  }
}
