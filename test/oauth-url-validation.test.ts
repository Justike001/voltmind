import { describe, expect, test } from 'bun:test';
import {
  validateOAuthIssuerUrl,
  validateAdminPublicUrl,
  validateOAuthMetadataEndpoints,
  validateRemoteMcpUrl,
  deriveDefaultMcpResourceUrl,
} from '../src/core/oauth-url-validation.ts';
import { smokeTestMcp } from '../src/core/remote-mcp-probe.ts';

describe('OAuth issuer and endpoint validation', () => {
  test('accepts production HTTPS issuer and same-origin token endpoint', () => {
    const result = validateOAuthMetadataEndpoints(
      'https://brain.example',
      { issuer: 'https://brain.example/', token_endpoint: 'https://brain.example/token' },
    );
    expect(result.ok).toBe(true);
  });

  test('rejects issuer mismatch exactly, including path differences', () => {
    const result = validateOAuthMetadataEndpoints(
      'https://brain.example/oauth',
      { issuer: 'https://brain.example', token_endpoint: 'https://brain.example/token' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('issuer mismatch');
  });

  test('rejects a non-loopback HTTP production issuer', () => {
    const result = validateOAuthIssuerUrl('http://brain.example');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('HTTPS');
  });

  test('Admin public URL allows HTTPS and loopback HTTP but rejects public HTTP', () => {
    expect(validateAdminPublicUrl('https://admin.example.internal').ok).toBe(true);
    expect(validateAdminPublicUrl('http://127.0.0.1:3131').ok).toBe(true);
    const publicHttp = validateAdminPublicUrl('http://admin.example.internal');
    expect(publicHttp.ok).toBe(false);
    if (!publicHttp.ok) expect(publicHttp.message).toContain('HTTPS');
  });

  test('Admin public URL is an origin rather than a path or query-bearing redirect', () => {
    expect(validateAdminPublicUrl('https://admin.example/internal').ok).toBe(false);
    expect(validateAdminPublicUrl('https://admin.example/?next=https://attacker.example').ok).toBe(false);
  });

  test('rejects a non-loopback HTTP token endpoint before credentials are sent', () => {
    const result = validateOAuthMetadataEndpoints(
      'https://brain.example',
      { issuer: 'https://brain.example/', token_endpoint: 'http://brain.example/token' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('HTTPS');
  });

  test('rejects a cross-origin token endpoint by default', () => {
    const result = validateOAuthMetadataEndpoints(
      'https://brain.example',
      { issuer: 'https://brain.example/', token_endpoint: 'https://identity.example/token' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('not trusted');
  });

  test('accepts a cross-origin HTTPS token endpoint only when explicitly allowlisted', () => {
    const result = validateOAuthMetadataEndpoints(
      'https://brain.example',
      { issuer: 'https://brain.example/', token_endpoint: 'https://identity.example/token' },
      { allowedTokenEndpointOrigins: ['https://identity.example'] },
    );
    expect(result.ok).toBe(true);
  });

  test('keeps HTTP loopback available for local development fixtures', () => {
    const result = validateOAuthMetadataEndpoints(
      'http://127.0.0.1:3131',
      { issuer: 'http://127.0.0.1:3131/', token_endpoint: 'http://127.0.0.1:3131/token' },
    );
    expect(result.ok).toBe(true);
  });

  test('accepts a same-origin MCP endpoint and loopback development endpoint', () => {
    const production = validateRemoteMcpUrl('https://brain.example', 'https://brain.example/mcp');
    const loopback = validateRemoteMcpUrl('http://127.0.0.1:3131', 'http://127.0.0.1:3131/mcp');
    expect(production.ok).toBe(true);
    expect(loopback.ok).toBe(true);
  });

  test('default MCP resource remains the root Express route when issuer has a path', () => {
    expect(deriveDefaultMcpResourceUrl(new URL('https://brain.example/oauth')).href)
      .toBe('https://brain.example/mcp');
  });

  test('rejects insecure, credentialed, fragmented, and cross-origin MCP endpoints', () => {
    const insecure = validateRemoteMcpUrl('https://brain.example', 'http://brain.example/mcp');
    const credentialed = validateRemoteMcpUrl('https://brain.example', 'https://user:pass@brain.example/mcp');
    const fragmented = validateRemoteMcpUrl('https://brain.example', 'https://brain.example/mcp#fragment');
    const crossOrigin = validateRemoteMcpUrl('https://brain.example', 'https://attacker.example/mcp');
    expect(insecure.ok).toBe(false);
    expect(credentialed.ok).toBe(false);
    expect(fragmented.ok).toBe(false);
    expect(crossOrigin.ok).toBe(false);
    if (!crossOrigin.ok) expect(crossOrigin.message).toContain('not trusted');
  });

  test('accepts cross-origin MCP only through its dedicated allowlist', () => {
    const result = validateRemoteMcpUrl(
      'https://brain.example',
      'https://mcp.example/mcp',
      { allowedMcpEndpointOrigins: ['https://mcp.example'] },
    );
    expect(result.ok).toBe(true);
  });

  test('smoke probe rejects an untrusted endpoint without transmitting its bearer', async () => {
    const result = await smokeTestMcp('https://attacker.example/mcp', 'test-bearer-token', {
      issuerUrl: 'https://brain.example',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'config',
      message: 'MCP endpoint origin https://attacker.example is not trusted by issuer https://brain.example',
    });
  });
});
