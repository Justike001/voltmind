/**
 * Shared OAuth issuer/token endpoint validation for both the HTTP host and
 * thin clients. Production endpoints are HTTPS-only; loopback HTTP remains
 * available for local development and test fixtures.
 */

export interface OAuthEndpointValidationOptions {
  /** Additional token endpoint origins explicitly trusted by the operator. */
  allowedTokenEndpointOrigins?: readonly string[];
  /** OAuth permits loopback HTTP for local/native development. Default true. */
  allowInsecureLoopback?: boolean;
}

/**
 * Trust policy for the endpoint that receives OAuth bearer tokens. Kept
 * separate from `allowedTokenEndpointOrigins`: a token endpoint allowlist
 * does not authorize a different MCP server to receive that token.
 */
export interface RemoteMcpEndpointValidationOptions {
  /** Additional origins explicitly trusted to receive bearer tokens over MCP. */
  allowedMcpEndpointOrigins?: readonly string[];
  /** OAuth permits loopback HTTP for local/native development. Default true. */
  allowInsecureLoopback?: boolean;
}

export type OAuthUrlValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1';
}

function parseHttpsOrLoopbackUrl(
  raw: string,
  label: string,
  allowInsecureLoopback: boolean,
): OAuthUrlValidationResult<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: `${label} must be an absolute URL` };
  }
  if (url.username || url.password) {
    return { ok: false, message: `${label} must not contain URL credentials` };
  }
  if (url.hash) {
    return { ok: false, message: `${label} must not contain a fragment` };
  }
  if (url.protocol === 'https:') return { ok: true, value: url };
  if (url.protocol === 'http:' && allowInsecureLoopback && isLoopbackHostname(url.hostname)) {
    return { ok: true, value: url };
  }
  return {
    ok: false,
    message: `${label} must use HTTPS${allowInsecureLoopback ? ' (HTTP is allowed only for loopback development)' : ''}`,
  };
}

function validatedAllowedOrigins(
  rawOrigins: readonly string[] | undefined,
  label: string,
  allowInsecureLoopback: boolean,
): OAuthUrlValidationResult<Set<string>> {
  const origins = new Set<string>();
  for (const rawOrigin of rawOrigins ?? []) {
    const parsed = parseHttpsOrLoopbackUrl(rawOrigin, `${label} allowlist entry`, allowInsecureLoopback);
    if (!parsed.ok) return parsed;
    if (parsed.value.origin !== rawOrigin.replace(/\/$/, '')) {
      return { ok: false, message: `${label} allowlist entries must be origins: ${rawOrigin}` };
    }
    origins.add(parsed.value.origin);
  }
  return { ok: true, value: origins };
}

/** Validate the issuer URL the host publishes and embeds in access tokens. */
export function validateOAuthIssuerUrl(
  issuerUrl: string,
  opts: Pick<OAuthEndpointValidationOptions, 'allowInsecureLoopback'> = {},
): OAuthUrlValidationResult<URL> {
  const allowInsecureLoopback = opts.allowInsecureLoopback ?? true;
  const parsed = parseHttpsOrLoopbackUrl(issuerUrl, 'issuer_url', allowInsecureLoopback);
  if (!parsed.ok) return parsed;
  if (parsed.value.search) {
    return { ok: false, message: 'issuer_url must not contain a query string' };
  }
  return parsed;
}

/**
 * Validate the public Admin origin before it is used for session cookies or
 * magic links. An explicit non-loopback HTTP origin would make an HttpOnly
 * session cookie observable on the network, so production Admin endpoints
 * follow the same HTTPS-or-loopback policy as the OAuth issuer.
 */
export function validateAdminPublicUrl(
  adminUrl: string,
  opts: Pick<OAuthEndpointValidationOptions, 'allowInsecureLoopback'> = {},
): OAuthUrlValidationResult<URL> {
  const allowInsecureLoopback = opts.allowInsecureLoopback ?? true;
  const parsed = parseHttpsOrLoopbackUrl(adminUrl, 'admin_public_url', allowInsecureLoopback);
  if (!parsed.ok) return parsed;
  if (parsed.value.search) return { ok: false, message: 'admin_public_url must not contain a query string' };
  if (parsed.value.pathname !== '/') return { ok: false, message: 'admin_public_url must be an origin, not a path' };
  return parsed;
}

/**
 * The built-in Express transport is mounted at the root `/mcp` route. OAuth
 * issuers may carry a public proxy path, but that path is not an Express route
 * unless an operator explicitly supplies the complete public MCP resource.
 */
export function deriveDefaultMcpResourceUrl(issuerUrl: URL): URL {
  return new URL('/mcp', issuerUrl);
}

/**
 * Validate RFC 8414 discovery metadata before any credential is transmitted.
 * The metadata issuer must exactly match the configured issuer identifier.
 * The token endpoint must be HTTPS (except loopback development) and same
 * origin unless the operator explicitly allowlists another origin.
 */
export function validateOAuthMetadataEndpoints(
  configuredIssuer: string,
  metadata: { issuer?: unknown; token_endpoint?: unknown },
  opts: OAuthEndpointValidationOptions = {},
): OAuthUrlValidationResult<{ issuer: URL; tokenEndpoint: URL }> {
  const allowInsecureLoopback = opts.allowInsecureLoopback ?? true;
  const issuer = validateOAuthIssuerUrl(configuredIssuer, { allowInsecureLoopback });
  if (!issuer.ok) return issuer;

  // Compare against the URL parser's canonical serialization. In particular,
  // an origin-only URL serializes with `/`, matching RFC 8414 metadata emitted
  // by the MCP SDK even when the operator typed the flag without that slash.
  const expectedIssuer = issuer.value.href;
  if (typeof metadata.issuer !== 'string' || metadata.issuer !== expectedIssuer) {
    return {
      ok: false,
      message: `OAuth discovery issuer mismatch: expected ${expectedIssuer}`,
    };
  }
  if (typeof metadata.token_endpoint !== 'string') {
    return { ok: false, message: 'OAuth discovery missing token_endpoint' };
  }
  const tokenEndpoint = parseHttpsOrLoopbackUrl(
    metadata.token_endpoint,
    'token_endpoint',
    allowInsecureLoopback,
  );
  if (!tokenEndpoint.ok) return tokenEndpoint;

  const configuredAllowedOrigins = validatedAllowedOrigins(
    opts.allowedTokenEndpointOrigins,
    'Token endpoint',
    allowInsecureLoopback,
  );
  if (!configuredAllowedOrigins.ok) return configuredAllowedOrigins;
  const allowedOrigins = new Set<string>([issuer.value.origin, ...configuredAllowedOrigins.value]);
  if (!allowedOrigins.has(tokenEndpoint.value.origin)) {
    return {
      ok: false,
      message: `OAuth token_endpoint origin ${tokenEndpoint.value.origin} is not trusted by issuer ${issuer.value.origin}`,
    };
  }

  return { ok: true, value: { issuer: issuer.value, tokenEndpoint: tokenEndpoint.value } };
}

/**
 * Validate the MCP endpoint before an OAuth bearer token can be sent to it.
 * By default it must share the issuer origin; cross-origin routing is an
 * explicit operator decision via a distinct MCP endpoint allowlist.
 */
export function validateRemoteMcpUrl(
  configuredIssuer: string,
  mcpUrl: string,
  opts: RemoteMcpEndpointValidationOptions = {},
): OAuthUrlValidationResult<{ issuer: URL; mcpEndpoint: URL }> {
  const allowInsecureLoopback = opts.allowInsecureLoopback ?? true;
  const issuer = validateOAuthIssuerUrl(configuredIssuer, { allowInsecureLoopback });
  if (!issuer.ok) return issuer;

  const mcpEndpoint = parseHttpsOrLoopbackUrl(mcpUrl, 'mcp_url', allowInsecureLoopback);
  if (!mcpEndpoint.ok) return mcpEndpoint;

  const configuredAllowedOrigins = validatedAllowedOrigins(
    opts.allowedMcpEndpointOrigins,
    'MCP endpoint',
    allowInsecureLoopback,
  );
  if (!configuredAllowedOrigins.ok) return configuredAllowedOrigins;
  const allowedOrigins = new Set<string>([issuer.value.origin, ...configuredAllowedOrigins.value]);
  if (!allowedOrigins.has(mcpEndpoint.value.origin)) {
    return {
      ok: false,
      message: `MCP endpoint origin ${mcpEndpoint.value.origin} is not trusted by issuer ${issuer.value.origin}`,
    };
  }
  return { ok: true, value: { issuer: issuer.value, mcpEndpoint: mcpEndpoint.value } };
}
