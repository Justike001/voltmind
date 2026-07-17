import { describe, expect, test } from 'bun:test';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operations } from '../src/core/operations.ts';
import {
  checkSkillify,
  listResolvers,
} from '../src/core/skill-platform-diagnostics.ts';

const P1_DIAGNOSTIC_OPERATIONS = [
  'skillify_check',
  'list_skillpack_skills',
  'get_skillpack_health',
  'diff_skillpack_skill',
  'check_skill_tree',
  'evaluate_skill_routing',
  'list_resolvers',
  'describe_resolver',
  'audit_frontmatter',
];

describe('P1 skill-platform MCP surface', () => {
  test('publishes only admin-scoped diagnostic operations', () => {
    for (const name of P1_DIAGNOSTIC_OPERATIONS) {
      const op = operations.find(candidate => candidate.name === name);
      expect(op).toBeDefined();
      expect(op?.scope).toBe('admin');
      expect(op?.localOnly).toBe(false);
      expect(op?.mutating).not.toBe(true);
    }
  });

  test('rejects a skillify target that escapes the repository root', () => {
    expect(() => checkSkillify('../package.json')).toThrow('target must stay within');
  });

  test('returns registered resolver metadata without executing a resolver', () => {
    const resolvers = listResolvers();
    expect(resolvers.map(resolver => resolver.id)).toContain('url_reachable');
  });

  test('enforces source scope before a frontmatter audit touches the engine', async () => {
    const result = await dispatchToolCall(
      {} as never,
      'audit_frontmatter',
      { source_id: 'outside-grant' },
      { remote: true, auth: { allowedSources: ['default'] } as never },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('permission_denied');
  });
});
