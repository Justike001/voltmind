/**
 * test/autopilot-full-cycle-gate.test.ts
 *
 * #1171 regression guards for the "no_successful_full_cycle" staleness.
 *
 * Root cause (see analysis): the autopilot dispatch gate (`shouldFullCycle`)
 * gated the 60-min full-cycle floor behind `score>=95 && plan.length===0`.
 * A score~85 brain with a recurring 2-step targeted plan (sync+extract) ran
 * targeted jobs every tick and NEVER dispatched an `autopilot-cycle` job.
 * The readiness probe (`readBusinessReadiness`) only counts a completed
 * `autopilot-cycle` row as evidence of a full cycle, so minion_jobs never
 * got one → the probe reported `no_successful_full_cycle` / `degraded`
 * permanently, even though targeted work ran fine.
 *
 * Fix: the decision is extracted into the pure `shouldRunFullCycle`, which
 *   (1) drops the score>=95/empty-plan requirement on the 60-min floor, and
 *   (2) forces a full cycle when `minion_jobs` has never recorded a
 *       successful `autopilot-cycle` (`neverHadFullCycle`), so the probe
 *       eventually has evidence to observe.
 *
 * The autopilot daemon loop is hard to unit-test without a full engine, so
 * these are pure-function tests (established pattern: autopilot-fanout.test.ts
 * and cycle-abort.test.ts) plus source-level guards.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import {
  shouldRunFullCycle,
  minionHasSuccessfulCycle,
} from '../src/commands/autopilot.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const autopilotSource = readFileSync(
  new URL('../src/commands/autopilot.ts', import.meta.url),
  'utf8',
);

function base() {
  return {
    neverHadFullCycle: false,
    minutesSinceLastFull: 0,
    score: 85,
    planLength: 2,
    estTotal: 120,
  };
}

describe('shouldRunFullCycle — full-cycle dispatch gate', () => {
  test('never had a successful full cycle forces a full cycle regardless of the small plan', () => {
    // The #1171 regression: score 85, 2-step plan → old gate never fired.
    expect(shouldRunFullCycle({ ...base(), neverHadFullCycle: true })).toBe(true);
  });

  test('60-min floor fires independent of score/plan (drop of 95/empty requirement)', () => {
    // Old gate required score>=95 && plan empty. Now the floor alone, even
    // on a mid-score brain with a live targeted plan, drives a full cycle.
    expect(
      shouldRunFullCycle({ ...base(), minutesSinceLastFull: 61 }),
    ).toBe(true);
  });

  test('small plan + fresh cycle + healthy score => no full cycle (targeted loop)', () => {
    expect(shouldRunFullCycle({ ...base() })).toBe(false);
  });

  test('large plan (>3) forces full cycle', () => {
    expect(shouldRunFullCycle({ ...base(), planLength: 4 })).toBe(true);
  });

  test('slow plan (>=300s) forces full cycle', () => {
    expect(shouldRunFullCycle({ ...base(), estTotal: 300 })).toBe(true);
  });

  test('critically low score (<70) forces full cycle', () => {
    expect(shouldRunFullCycle({ ...base(), score: 69 })).toBe(true);
  });

  test('healthy 95/empty plan still full-cycles on the 60-min floor', () => {
    expect(
      shouldRunFullCycle({
        neverHadFullCycle: false,
        minutesSinceLastFull: 75,
        score: 97,
        planLength: 0,
        estTotal: 0,
      }),
    ).toBe(true);
  });

  test('healthy 95/empty plan sleeps before the floor elapses', () => {
    expect(
      shouldRunFullCycle({
        neverHadFullCycle: false,
        minutesSinceLastFull: 10,
        score: 97,
        planLength: 0,
        estTotal: 0,
      }),
    ).toBe(false);
  });

  test('custom floor respected', () => {
    expect(
      shouldRunFullCycle({ ...base(), minutesSinceLastFull: 30, fullCycleFloorMin: 30 }),
    ).toBe(true);
  });
});

describe('minionHasSuccessfulCycle — durable evidence the probe can observe', () => {
  function engineWith(result: unknown): BrainEngine {
    return {
      executeRaw: async () => [{ result }],
    } as unknown as BrainEngine;
  }

  test('completed autopilot-cycle with status ok counts as a full cycle', async () => {
    const engine = engineWith({ status: 'ok', report: { phases: [] } });
    expect(await minionHasSuccessfulCycle(engine)).toBe(true);
  });

  test('status clean also counts', async () => {
    const engine = engineWith({ status: 'clean' });
    expect(await minionHasSuccessfulCycle(engine)).toBe(true);
  });

  test('status failed/skipped/partial does NOT count', async () => {
    for (const s of ['failed', 'skipped', 'partial']) {
      expect(await minionHasSuccessfulCycle(engineWith({ status: s }))).toBe(false);
    }
  });

  test('no rows => false (the #1171 degraded state)', async () => {
    const engine = { executeRaw: async () => [] } as unknown as BrainEngine;
    expect(await minionHasSuccessfulCycle(engine)).toBe(false);
  });

  test('JSON-stringified result is decoded before status check', async () => {
    const engine = engineWith(JSON.stringify({ status: 'ok' }));
    expect(await minionHasSuccessfulCycle(engine)).toBe(true);
  });

  test('unparseable result is fail-closed (false)', async () => {
    const engine = engineWith('not-json{{{');
    expect(await minionHasSuccessfulCycle(engine)).toBe(false);
  });
});

describe('source-level guards — dispatch gate uses the extracted rule', () => {
  test('inline gate calls shouldRunFullCycle with neverHadFullCycle', () => {
    const dispatchContext = autopilotSource.slice(
      autopilotSource.indexOf('const shouldFullCycle = shouldRunFullCycle'),
      0 || autopilotSource.indexOf('const shouldSleep'),
    );
    // Both the probe and the gate are wired in the same dispatch block.
    expect(dispatchContext).toMatch(/neverHadFullCycle/);
    expect(dispatchContext).toMatch(/shouldRunFullCycle\(/);
  });

  test('the old score>=95 && empty-plan gated floor is gone', () => {
    // The pre-#1171 floor glued the 60-min floor to a healthy empty plan
    // INSIDE the shouldFullCycle assignment. Match only that assignment
    // shape (comment text spells the same idea but without `const should…=`).
    expect(autopilotSource).not.toMatch(
      /const\s+shouldFullCycle\s*=\s*[^;]*score[^;]*plan\.length[^;]*minutesSinceLastFull/,
    );
  });

  test('readiness probe and gate agree on successful-cycle semantics', () => {
    // Both places treat result.status 'ok'/'clean' as the success signal —
    // grep confirms both spell it out so they cannot drift silently.
    const okMatches = autopilotSource.match(/['"]ok['"]/g) ?? [];
    const cleanMatches = autopilotSource.match(/['"]clean['"]/g) ?? [];
    // readBusinessReadiness (ok|clean) + minionHasSuccessfulCycle (ok|clean).
    expect(okMatches.length).toBeGreaterThanOrEqual(2);
    expect(cleanMatches.length).toBeGreaterThanOrEqual(2);
  });
});
