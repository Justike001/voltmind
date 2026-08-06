/**
 * put_page L2 extract enqueue tests (v0.43).
 *
 * A remote (MCP) put_page deliberately skips inline auto-link/timeline for
 * security. L2 compensates by enqueuing a durable, per-slug `extract` minion
 * job so the page's links/timeline are reconciled from its write-through
 * checkout file without waiting for the next autopilot tick.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { operations } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { resetGateway } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let tmpRoot: string;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // resetPgliteState TRUNCATEs `config`, wiping the `version` key that
  // MinionQueue.ensureSchema() reads (needs >= 7). Restore it so the
  // durable queue accepts the L2 extract enqueue.
  await engine.setConfig('version', '999');
  resetGateway();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voltmind-l2-'));
  brainDir = path.join(tmpRoot, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  await engine.setConfig('sync.repo_path', brainDir);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const putPage = operations.find((o) => o.name === 'put_page')!;

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

async function waitForExtractJob(slug: string, tries = 20): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < tries; i++) {
    const rows = await engine.executeRaw<{ data: unknown }>(
      `SELECT data FROM minion_jobs WHERE name = 'extract' AND idempotency_key = $1`,
      [`put-page-extract:default:${slug}`],
    );
    if (rows.length > 0) {
      // PGLite returns JSONB already-deserialized; Postgres may return a string.
      return typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : (rows[0].data as Record<string, unknown>);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

function asObj(data: Record<string, unknown> | null): Record<string, unknown> {
  // data is already a plain object; keep as-is.
  return data as Record<string, unknown>;
}

describe('put_page L2 — remote write enqueues per-slug extract', () => {
  test('plain remote MCP caller skips auto-link but enqueues an extract job', async () => {
    const ctx = makeCtx({ remote: true });
    const result = (await putPage.handler(ctx, {
      slug: 'notes/l2-remote',
      content: [
        '---',
        'type: note',
        'title: L2 Remote',
        '---',
        '',
        'Remote note referencing [alice](../people/alice.md).',
      ].join('\n'),
    })) as { write_through?: { written?: boolean; skipped?: string } };

    // Write-through should have produced an on-disk file (dir for extract).
    expect(result.write_through?.written).toBe(true);

    const data = await waitForExtractJob('notes/l2-remote');
    expect(data).not.toBeNull();
    expect(asObj(data).mode).toBe('all');
    expect(asObj(data).slugs).toEqual(['notes/l2-remote']);
    expect(asObj(data).dir).toBe(brainDir);
    expect(asObj(data).sourceId).toBe('default');
  });

  test('local (non-remote) put_page does NOT enqueue an extract job (auto-link path)', async () => {
    const ctx = makeCtx({ remote: false });
    await putPage.handler(ctx, {
      slug: 'notes/l2-local',
      content: [
        '---',
        'type: note',
        'title: L2 Local',
        '---',
        '',
        'Local note body.',
      ].join('\n'),
    });
    // Give any (wrong) async enqueue a chance to land, then assert none.
    await new Promise((r) => setTimeout(r, 100));
    const rows = await engine.executeRaw(
      `SELECT 1 FROM minion_jobs WHERE name = 'extract' AND idempotency_key = 'put-page-extract:default:notes/l2-local'`,
    );
    expect(rows.length).toBe(0);
  });
});
