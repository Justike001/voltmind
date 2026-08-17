import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { isRowActivationKey, trappedFocusTarget } from '../admin/src/accessibility.ts';

describe('Admin keyboard accessibility', () => {
  test('interactive table rows activate only for Enter and Space', () => {
    expect(isRowActivationKey('Enter')).toBe(true);
    expect(isRowActivationKey(' ')).toBe(true);
    expect(isRowActivationKey('ArrowDown')).toBe(false);
  });

  test('dialog focus trap wraps in both directions', () => {
    const items = ['first', 'middle', 'last'] as const;
    expect(trappedFocusTarget(items, 'last', false)).toBe('first');
    expect(trappedFocusTarget(items, 'first', true)).toBe('last');
    expect(trappedFocusTarget(items, 'middle', false)).toBeUndefined();
    expect(trappedFocusTarget([], null, false)).toBeNull();
  });

  test('published Sources and Jobs rows and Modal wire the keyboard contract', () => {
    const src = readFileSync('admin/src/pages/AdminConsole.tsx', 'utf8');
    expect(src.match(/role="button" tabIndex=\{0\}/g)?.length).toBeGreaterThanOrEqual(2);
    expect(src).toContain('activateRow(event');
    expect(src).toContain("event.key === 'Escape'");
    expect(src).toContain("event.key !== 'Tab'");
    expect(src).toContain('previousFocus?.focus()');
    expect(src).toContain('aria-labelledby={titleId}');
  });
});
