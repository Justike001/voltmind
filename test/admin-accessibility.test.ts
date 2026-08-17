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

  test('OAuth, Jobs, and Audit pages distinguish initial loading from refreshes and empty results', () => {
    const src = readFileSync('admin/src/pages/AdminConsole.tsx', 'utf8');
    // These data-driven pages must not briefly report an empty system while
    // their initial request or an explicit refresh is still in flight.
    expect(src.match(/const \[loading, setLoading\] = useState\(true\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src.match(/const \[loaded, setLoaded\] = useState\(false\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src.match(/finally \{ setLoading\(false\); \}/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src).toContain('{loading && !loaded ? <Loading /> : loaded ? <OAuthTable');
    expect(src).toContain('{loading && !loaded ? <Loading /> : loaded ? visibleJobs.length');
    expect(src).toContain('{loading && !loaded ? <Loading /> : loaded ? entries.length');
  });

  test('published Admin SPA has no raw HTML or browser-persisted credential sink', () => {
    const src = readFileSync('admin/src/pages/AdminConsole.tsx', 'utf8');
    const api = readFileSync('admin/src/api.ts', 'utf8');
    const login = readFileSync('admin/src/pages/Login.tsx', 'utf8');
    const published = `${src}\n${api}\n${login}`;
    expect(published).not.toContain('dangerouslySetInnerHTML');
    expect(published).not.toMatch(/\b(?:localStorage|sessionStorage)\b/);
  });
});
