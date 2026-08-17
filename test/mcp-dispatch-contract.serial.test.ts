import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError, operations } from '../src/core/operations.ts';
import type { Operation } from '../src/core/operations.ts';
import {
  dispatchToolCall,
  sanitizeInternalErrorMessage,
  validateParams,
} from '../src/mcp/dispatch.ts';

function syntheticOperation(params: Operation['params']): Operation {
  return {
    name: 'synthetic_contract_test',
    description: 'Synthetic operation used to pin ParamDef validation.',
    scope: 'read',
    params,
    handler: async () => null,
  };
}

describe('MCP ParamDef runtime validation', () => {
  const op = syntheticOperation({
    mode: { type: 'string', enum: ['fast', 'safe'], required: true },
    limit: { type: 'number', default: 10 },
    matrix: {
      type: 'array',
      items: { type: 'array', items: { type: 'number' } },
    },
  });

  test('accepts values that satisfy the published recursive schema', () => {
    expect(validateParams(op, {
      mode: 'safe',
      limit: 5,
      matrix: [[1, 2], [3]],
    })).toBeNull();
  });

  test('allows an omitted optional default without mutating the instance', () => {
    const params = { mode: 'fast' };
    expect(validateParams(op, params)).toBeNull();
    expect(params).toEqual({ mode: 'fast' });
  });

  test('rejects enum violations, unknown fields, non-finite numbers, and nested item mismatches', () => {
    expect(validateParams(op, { mode: 'turbo' })).toContain('must be one of');
    expect(validateParams(op, { mode: 'safe', surprise: true })).toBe('Unknown parameter: surprise');
    expect(validateParams(op, { mode: 'safe', limit: Number.NaN })).toContain('finite number');
    expect(validateParams(op, { mode: 'safe', limit: Number.POSITIVE_INFINITY })).toContain('finite number');
    expect(validateParams(op, { mode: 'safe', matrix: [[1, 'bad']] })).toContain('matrix[0][1]');
  });
});

describe('unexpected MCP errors are safe for remote callers', () => {
  test('returns only a stable code/request id and redacts the local diagnostic', async () => {
    const search = operations.find((candidate) => candidate.name === 'search')!;
    const originalHandler = search.handler;
    const logged: string[] = [];
    let scopeSeen: string | undefined;
    let transactionCount = 0;
    const fakeEngine = {
      kind: 'postgres',
      async transaction<T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
        transactionCount += 1;
        return fn(this as unknown as BrainEngine);
      },
      async setSourceScope(sourceId: string) { scopeSeen = sourceId; },
    } as unknown as BrainEngine;

    search.handler = async () => {
      throw new Error(
        'SELECT secret FROM vault at C:\\Users\\alice\\private\\brain.db client_secret=hunter2 alice@example.com',
      );
    };
    try {
      const result = await dispatchToolCall(fakeEngine, 'search', { query: 'x' }, {
        remote: true,
        sourceId: 'team-a',
        logger: {
          info: () => {},
          warn: () => {},
          error: (message) => logged.push(message),
        },
      });
      const body = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
      expect(result.isError).toBe(true);
      expect(body.error).toBe('internal_error');
      expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(Object.keys(body).sort()).toEqual(['error', 'request_id']);
      expect(result.content[0]!.text).not.toContain('SELECT');
      expect(result.content[0]!.text).not.toContain('hunter2');
      expect(transactionCount).toBe(1);
      expect(scopeSeen).toBe('team-a');
      expect(logged.join('\n')).toContain(String(body.request_id));
      expect(logged.join('\n')).not.toContain('hunter2');
      expect(logged.join('\n')).not.toContain('alice@example.com');
      expect(logged.join('\n')).not.toContain('C:\\Users\\alice');
    } finally {
      search.handler = originalHandler;
    }
  });

  test('standalone sanitizer covers path, SQL, credential, and email shapes', () => {
    const safe = sanitizeInternalErrorMessage(
      'failed /home/alice/private.sql password=p4ss alice@example.com',
    );
    expect(safe).not.toContain('/home/alice');
    expect(safe).not.toContain('p4ss');
    expect(safe).not.toContain('alice@example.com');
  });

  test('remote OperationError messages are sanitized before serialization', async () => {
    const search = operations.find((candidate) => candidate.name === 'search')!;
    const originalHandler = search.handler;
    const fakeEngine = {
      kind: 'pglite',
      async setSourceScope() {},
    } as unknown as BrainEngine;
    search.handler = async () => {
      throw new OperationError(
        'storage_error',
        'Cannot read C:\\Users\\alice\\private vault\\page.md secret=hunter2',
      );
    };
    try {
      const result = await dispatchToolCall(fakeEngine, 'search', { query: 'x' }, {
        remote: true,
        sourceId: 'default',
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
      const serialized = result.content[0]!.text;
      expect(result.isError).toBe(true);
      expect(serialized).toContain('storage_error');
      expect(serialized).not.toContain('alice');
      expect(serialized).not.toContain('hunter2');
    } finally {
      search.handler = originalHandler;
    }
  });
});
