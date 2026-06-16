import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (let i = 0; i < 30; i++) {
    await engine.putPage(`notes/concurrent-${i}`, {
      type: 'note',
      title: `Concurrent ${i}`,
      compiled_truth: `Daemon same connection read concurrency fixture ${i}. Alpha beta gamma.`,
      frontmatter: { idx: i },
      timeline: '',
    });
  }
});

afterAll(async () => {
  await engine.disconnect();
});

describe('PGLite same-process same-connection concurrency', () => {
  test('pure read queries are reliable when issued concurrently on one engine', async () => {
    const tasks: Array<Promise<unknown>> = [];
    for (let i = 0; i < 50; i++) {
      tasks.push(engine.getPage(`notes/concurrent-${i % 30}`));
      tasks.push(engine.listPages({ slugPrefix: 'notes/concurrent-', limit: 30 }));
      tasks.push(engine.searchKeyword('concurrency fixture', { limit: 10 }));
      tasks.push(engine.getStats());
    }

    const results = await Promise.allSettled(tasks);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(rejected.map(r => r.reason instanceof Error ? r.reason.message : String(r.reason))).toEqual([]);
    expect(results.length).toBe(200);
  });

  test('read and write operations can overlap on one engine without corrupting reads', async () => {
    const readers: Array<Promise<unknown>> = [];
    for (let i = 0; i < 40; i++) {
      readers.push(engine.getPage(`notes/concurrent-${i % 30}`));
      readers.push(engine.searchKeyword('alpha beta', { limit: 5 }));
    }
    const writers = Array.from({ length: 10 }, (_, i) =>
      engine.putPage(`notes/write-overlap-${i}`, {
        type: 'note',
        title: `Write Overlap ${i}`,
        compiled_truth: `Write overlap fixture ${i}.`,
        frontmatter: { idx: i },
        timeline: '',
      }),
    );

    const results = await Promise.allSettled([...readers, ...writers]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(rejected.map(r => r.reason instanceof Error ? r.reason.message : String(r.reason))).toEqual([]);
    for (let i = 0; i < 10; i++) {
      expect(await engine.getPage(`notes/write-overlap-${i}`)).not.toBeNull();
    }
  });
});
