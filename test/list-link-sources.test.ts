import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { operationsByName } from '../src/core/operations.ts';

describe('list_link_sources', () => {
  test('is a remote-capable read operation', () => {
    const operation = operationsByName.list_link_sources;
    expect(operation).toBeDefined();
    expect(operation.scope).toBe('read');
    expect(operation.localOnly).not.toBe(true);
    expect(operation.cliHints?.name).toBe('link-sources');
  });

  test('federated scope constrains both link endpoints', async () => {
    let sql = '';
    let params: unknown[] | undefined;
    const engine = {
      executeRaw: async (statement: string, values?: unknown[]) => {
        sql = statement;
        params = values;
        return [{ link_source: 'citation-graph', edge_count: 2 }];
      },
    } as unknown as BrainEngine;
    const context = {
      engine,
      remote: true,
      sourceId: 'primary',
      auth: { allowedSources: ['primary', 'shared'] },
    } as OperationContext;
    const result = await operationsByName.list_link_sources.handler(context, {});
    expect(sql).toContain('f.source_id = ANY($1::text[])');
    expect(sql).toContain('t.source_id = ANY($1::text[])');
    expect(params).toEqual([['primary', 'shared']]);
    expect(result).toEqual([{ link_source: 'citation-graph', edge_count: 2 }]);
  });
});
