import { describe, expect, test } from 'bun:test';
import { toISODate, todayISO } from '../src/core/date-util.ts';

describe('date-util', () => {
  test('toISODate formats a Date as its UTC YYYY-MM-DD component', () => {
    // Fixed UTC instant. The UTC calendar date must win over the local one
    // so records are stable regardless of the runner's timezone.
    const d = new Date('2024-03-05T12:00:00Z');
    expect(toISODate(d)).toBe('2024-03-05');
  });

  test('toISODate matches the historical inline .toISOString().slice(0,10)', () => {
    const d = new Date('1999-12-31T23:59:59Z');
    expect(toISODate(d)).toBe(d.toISOString().slice(0, 10));
  });

  test('toISODate is stable across a late-evening UTC instant (boundary)', () => {
    // 23:59:59Z on the 31st — still the 31st in UTC even if local tz rolls over.
    const d = new Date('2024-05-31T23:59:59.999Z');
    expect(toISODate(d)).toBe('2024-05-31');
  });

  test('todayISO returns the current UTC date', () => {
    const now = new Date();
    expect(todayISO()).toBe(now.toISOString().slice(0, 10));
  });

  test('todayISO uses the same formatting as toISODate(new Date())', () => {
    expect(todayISO()).toBe(toISODate(new Date()));
  });
});
