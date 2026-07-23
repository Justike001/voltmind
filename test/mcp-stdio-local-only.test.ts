import { describe, expect, test } from 'bun:test';
import { getStdioMcpOperations } from '../src/mcp/server.ts';

describe('stdio MCP localOnly boundary', () => {
  test('does not advertise host-local operations to agent-facing callers', () => {
    const names = getStdioMcpOperations().map(op => op.name);
    for (const name of [
      'purge_deleted_pages',
      'sync_brain',
      'file_list',
      'file_upload',
      'file_url',
      'code_traversal_cache_clear',
    ]) {
      expect(names).not.toContain(name);
    }
  });
});
