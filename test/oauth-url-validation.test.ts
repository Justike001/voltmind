import { describe, expect, test } from 'bun:test';
import {
  validateOAuthIssuerUrl,
  validateOAuthMetadataEndpoints,
} from '../src/core/oauth-url-validation.ts';

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
});
