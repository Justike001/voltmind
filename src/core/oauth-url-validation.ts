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

  const allowedOrigins = new Set<string>([issuer.value.origin]);
  for (const rawOrigin of opts.allowedTokenEndpointOrigins ?? []) {
    let allowed: URL;
    try {
      allowed = new URL(rawOrigin);
    } catch {
      return { ok: false, message: `Invalid token endpoint allowlist origin: ${rawOrigin}` };
    }
    if (allowed.origin !== rawOrigin.replace(/\/$/, '')) {
      return { ok: false, message: `Token endpoint allowlist entries must be origins: ${rawOrigin}` };
    }
    if (allowed.protocol !== 'https:' && !(allowInsecureLoopback && allowed.protocol === 'http:' && isLoopbackHostname(allowed.hostname))) {
      return { ok: false, message: `Token endpoint allowlist origin must use HTTPS: ${rawOrigin}` };
    }
    allowedOrigins.add(allowed.origin);
  }
  if (!allowedOrigins.has(tokenEndpoint.value.origin)) {
    return {
      ok: false,
      message: `OAuth token_endpoint origin ${tokenEndpoint.value.origin} is not trusted by issuer ${issuer.value.origin}`,
    };
  }

  return { ok: true, value: { issuer: issuer.value, tokenEndpoint: tokenEndpoint.value } };
}
