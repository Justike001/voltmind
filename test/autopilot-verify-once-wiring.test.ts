/**
 * Regression guard for the operator-triggered full-cycle verification path.
 * It must remain a queue submission so validation exercises the supervised
 * worker rather than a convenient but unrepresentative inline code path.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const AUTOPILOT_SRC = readFileSync(
  join(import.meta.dir, '..', 'src', 'commands', 'autopilot.ts'),
  'utf8',
);

describe('autopilot --verify-once wiring', () => {
  test('routes the flag to the dedicated queue-backed submission helper', () => {
    expect(AUTOPILOT_SRC).toContain("if (args.includes('--verify-once'))");
    expect(AUTOPILOT_SRC).toContain('await submitVerificationCycle(engine, args)');
  });

  test('uses the ordinary full-cycle handler with retry and bounded waiting', () => {
    const start = AUTOPILOT_SRC.indexOf('export async function submitVerificationCycle');
    const end = AUTOPILOT_SRC.indexOf('export async function runAutopilot', start);
    const helper = AUTOPILOT_SRC.slice(start, end);
    expect(helper).toContain("'autopilot-cycle'");
    expect(helper).toContain('new MinionQueue(engine)');
    expect(helper).toContain('max_attempts: 2');
    expect(helper).toContain('maxWaiting: 1');
  });
});
