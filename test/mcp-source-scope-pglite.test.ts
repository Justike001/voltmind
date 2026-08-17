import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('writer.template_contract', 'off');
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
     VALUES ('source-a', 'Source A', '{}'::jsonb), ('source-b', 'Source B', '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
  );
  await engine.putPage('notes/same-slug', {
    type: 'note',
    title: 'Source A page',
    compiled_truth: 'alpha-only-content',
  }, { sourceId: 'source-a' });
  await engine.putPage('notes/same-slug', {
    type: 'note',
    title: 'Source B page',
    compiled_truth: 'beta-only-content',
  }, { sourceId: 'source-b' });
});

afterAll(async () => {
  await engine.disconnect();
});

describe('MCP dispatch source scope on PGLite', () => {
  test('remote put_page completes without a nested PGLite transaction', async () => {
    const result = await dispatchToolCall(engine, 'put_page', {
      slug: 'notes/remote-write',
      content: '---\ntype: note\ntitle: Remote write\n---\nScoped remote body.',
      source_id: 'source-a',
    }, {
      remote: true,
      sourceId: 'source-a',
    });
    expect(result.isError).toBeUndefined();
    expect((await engine.getPage('notes/remote-write', { sourceId: 'source-a' }))?.title).toBe('Remote write');
    expect(await engine.getPage('notes/remote-write', { sourceId: 'source-b' })).toBeNull();
  });

  test('positive: the scoped source remains visible', async () => {
    const result = await dispatchToolCall(engine, 'get_page', { slug: 'notes/same-slug' }, {
      remote: true,
      sourceId: 'source-a',
    });
    expect(result.isError).toBeUndefined();
    const page = JSON.parse(result.content[0]!.text) as { title: string; source_id: string };
    expect(page.title).toBe('Source A page');
    expect(page.source_id).toBe('source-a');
  });

  test('negative: a different source cannot bleed through the same slug', async () => {
    const result = await dispatchToolCall(engine, 'get_page', { slug: 'notes/same-slug' }, {
      remote: true,
      sourceId: 'source-b',
    });
    expect(result.isError).toBeUndefined();
    const page = JSON.parse(result.content[0]!.text) as { title: string; source_id: string };
    expect(page.title).toBe('Source B page');
    expect(page.source_id).toBe('source-b');
    expect(result.content[0]!.text).not.toContain('alpha-only-content');
  });
});
