import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SKILLS = join(ROOT, 'skills');

function readSkill(name: string): string {
  return readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf-8');
}

describe('VoltMind Personal Brain workflow skills', () => {
  test('resolver routes Phase 1 loops to MVP workflow skills', () => {
    const resolver = readFileSync(join(SKILLS, 'RESOLVER.md'), 'utf-8');
    expect(resolver).toContain('skills/meeting/SKILL.md');
    expect(resolver).toContain('skills/daily/SKILL.md');
    expect(resolver).toContain('skills/project/SKILL.md');
    expect(resolver).toContain('skills/review/SKILL.md');
    expect(resolver).toContain('inherited meeting enrichment');
    expect(resolver).not.toContain('| "meeting notes" | `skills/meeting-ingestion/SKILL.md` |');
  });

  test('workflow skill files exist and declare human-reviewed Phase 1 boundaries', () => {
    for (const name of ['meeting', 'daily', 'project', 'review']) {
      const path = join(SKILLS, name, 'SKILL.md');
      expect(existsSync(path)).toBe(true);
      const content = readSkill(name);
      expect(content).toContain('## Contract');
      expect(content).toContain('## Output Format');
      expect(content).toContain('## Anti-Patterns');
      expect(content).toContain('Phase 1');
    }
  });

  test('meeting skill keeps local-only contribution and policy gates', () => {
    const meeting = readSkill('meeting');
    expect(meeting).toContain('meetings/YYYY-MM-DD-topic.md');
    expect(meeting).toContain('state/actions/YYYY-MM-DD-action-slug.md');
    expect(meeting).toContain('state/commitments/YYYY-MM-DD-commitment-slug.md');
    expect(meeting).toContain('state/risks/risk-slug.md');
    expect(meeting).toContain('contribution/candidates/cand-YYYY-MM-DD-signal-slug.md');
    expect(meeting).toContain('Only write after explicit user approval');
    expect(meeting).toContain('publish_level: never');
    expect(meeting).toContain('Team Brain, Company Brain');
  });
});
