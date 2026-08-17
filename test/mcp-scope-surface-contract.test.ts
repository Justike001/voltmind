import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { operations } from '../src/core/operations.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';

describe('MCP scope/tool surface contract', () => {
  test('every published tool declares its required scope', () => {
    const defs = buildToolDefs(operations.filter(operation => !operation.localOnly));
    for (const def of defs) {
      const operation = operations.find(candidate => candidate.name === def.name)!;
      expect(def.scope).toBe(operation.scope ?? 'read');
      expect(def._meta['voltmind/requiredScope']).toBe(def.scope);
    }
  });

  test('stdio does not pre-map a scope-filtered known tool to unknown_tool', () => {
    const server = readFileSync('src/mcp/server.ts', 'utf8');
    expect(server).not.toContain('if (!mcpOperations.some(op => op.name === name))');
    expect(server).toContain('dispatchToolCall(engine, toolName, toolParams, dispatchOpts)');
    const dispatch = readFileSync('src/mcp/dispatch.ts', 'utf8');
    expect(dispatch).toContain("error: 'insufficient_scope'");
    const http = readFileSync('src/commands/serve-http.ts', 'utf8');
    expect(http).toContain("code: 'insufficient_scope'");
  });
});
