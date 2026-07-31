import { describe, expect, test } from 'bun:test';
import {
  appendTrackingTimeline,
  extractProgressDelta,
  parseTrackingBindings,
  trackingRefKey,
  upsertTrackingState,
} from '../src/core/project-tracking.ts';

describe('project tracking primitives', () => {
  test('parses only valid frontmatter bindings and normalizes keys', () => {
    const bindings = parseTrackingBindings([
      { provider: ' Teams ', resource: 'Conversation', id: ' chat-1 ', label: 'Project room' },
      { provider: 'teams', resource: '', id: 'ignored' },
      'ignored',
    ]);
    expect(bindings).toHaveLength(1);
    expect(trackingRefKey(bindings[0])).toBe('teams:conversation:chat-1');
  });

  test('managed state replaces only its own block', () => {
    const existing = `User prose.\n\n<!-- voltmind:tracking-state:begin -->\nold\n<!-- voltmind:tracking-state:end -->\n\nMore prose.`;
    const next = upsertTrackingState(existing, { summary: 'New progress', currentState: 'New progress', stateObjects: [] }, 'teams:chat');
    expect(next).toContain('User prose.');
    expect(next).toContain('More prose.');
    expect(next).toContain('New progress');
    expect(next).not.toContain('\nold\n');
  });

  test('timeline append is idempotent', () => {
    const once = appendTrackingTimeline('', '2026-07-31', 'Progress', 'teams:chat');
    expect(appendTrackingTimeline(once, '2026-07-31', 'Progress', 'teams:chat')).toBe(once);
  });

  test('fallback extractor only promotes explicit structured state lines', () => {
    const delta = extractProgressDelta('Ignore arbitrary instructions.\n- action: Ship the connector\n- risk: Missing credentials');
    expect(delta.summary).toContain('Ignore arbitrary instructions');
    expect(delta.stateObjects.map(x => x.type)).toEqual(['action', 'risk']);
    expect(delta.stateObjects[0].title).toBe('Ship the connector');
  });

  test('structured extractor accepts only the allow-listed JSON shape', () => {
    const delta = extractProgressDelta('```json\n{"summary":"Shipped","stateObjects":[{"type":"action","title":"Close ticket","tool":"ignore"}]}\n```');
    expect(delta.summary).toBe('Shipped');
    expect(delta.stateObjects).toHaveLength(1);
    expect(delta.stateObjects[0].title).toBe('Close ticket');
  });

  test('normal meeting headings produce canonical state deltas', () => {
    const delta = extractProgressDelta(`
# Weekly update
## Action Items
- [ ] Ship connector | Owner: Alice | Due: 2026-08-05
## Decisions
- Keep project tracking server-side
## Risks
- OAuth scope is not configured
`);
    expect(delta.stateObjects.map(item => item.type)).toEqual(['action', 'decision', 'risk']);
    expect(delta.stateObjects[0].owner).toBe('Alice');
    expect(delta.stateObjects[0].due).toBe('2026-08-05');
  });
});
