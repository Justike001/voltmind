import { describe, expect, test } from 'bun:test';
import {
  OperationError,
  resolveReadSourceScope,
} from '../src/core/operations.ts';

function context(overrides: Record<string, unknown> = {}) {
  return {
    remote: true,
    sourceId: 'team-a',
    auth: {
      token: 'test',
      clientId: 'client',
      scopes: ['read'],
      sourceId: 'team-a',
      allowedSources: ['team-a', 'shared'],
    },
    ...overrides,
  } as any;
}

describe('resolveReadSourceScope', () => {
  test('remote callers can narrow to an authorized source', () => {
    expect(resolveReadSourceScope(context(), 'shared')).toEqual({ sourceId: 'shared' });
  });

  test('remote __all__ remains constrained to the authorized federation', () => {
    expect(resolveReadSourceScope(context(), '__all__')).toEqual({
      sourceIds: ['team-a', 'shared'],
    });
  });

  test('remote callers cannot request a source outside their authorization', () => {
    expect(() => resolveReadSourceScope(context(), 'team-b')).toThrow(OperationError);
  });

  test('remote stdio callers fall back to their scalar source scope', () => {
    expect(resolveReadSourceScope(context({ auth: undefined }), '__all__')).toEqual({
      sourceId: 'team-a',
    });
    expect(() => resolveReadSourceScope(context({ auth: undefined }), 'team-b')).toThrow(OperationError);
  });

  test('trusted local CLI callers may opt into cross-source retrieval', () => {
    expect(resolveReadSourceScope(context({ remote: false }), '__all__')).toEqual({});
  });
});
