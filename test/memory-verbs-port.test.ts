import { describe, expect, test } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';

describe('entity and synthesize MCP capability', () => {
  for (const name of ['entity', 'synthesize']) {
    test(`${name} is a remote-capable read operation`, () => {
      const operation = operationsByName[name];
      expect(operation).toBeDefined();
      expect(operation?.scope).toBe('read');
      expect(operation?.localOnly).not.toBe(true);
      expect(operation?.mutating).not.toBe(true);
    });
  }

  test('entity and synthesize retain distinct cost semantics', () => {
    expect(operationsByName.entity.description).toContain('Zero LLM');
    expect(operationsByName.synthesize.description).toContain('EXPENSIVE / SLOW');
  });
});
