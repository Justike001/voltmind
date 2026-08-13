import { describe, expect, test } from 'bun:test';
import {
  loadCanonicalPageTemplateContract,
  resolveTemplateContractMode,
  validateCanonicalPageTemplate,
} from '../src/core/page-template-contract.ts';

const PERSONAL_PACK = {
  page_types: [
    { name: 'project', path_prefixes: ['projects/'] },
    { name: 'action', path_prefixes: ['state/actions/'] },
    { name: 'person', path_prefixes: ['people/'] },
  ],
};

const VALID_PROJECT = `---
id: project-example
type: project
title: Example Project
owner: people/owner-slug
scope: private
visibility: private
sensitivity: internal
promotion: allowed
publish_level: candidate
source_refs: []
related_entities: []
created: 2026-08-05
updated: 2026-08-05
status: active
my_role: owner
team: orgs/team-slug
workstream: workstreams/workstream-slug
tracking_bindings: []
tracking_aliases: []
related_people: []
related_companies: []
related_systems: []
deadline: 2026-12-31
tags: []
---

# Example Project

当前状态说明。

<!-- voltmind:tracking-state:begin -->
## Tracked Current State

当前进展说明。
<!-- voltmind:tracking-state:end -->

## State
## Open Questions
## Decisions
## Commitments
## Risks
## Links

<!-- timeline -->

## Timeline

- **2026-08-05** | 项目模板合同已启用。[Source: 测试]
`;

describe('canonical page template contract', () => {
  test('loads every page type defined by the canonical draft', () => {
    const contract = loadCanonicalPageTemplateContract();
    expect(contract.templates.size).toBe(19);
    for (const type of ['person', 'company', 'project', 'meeting', 'action', 'decision', 'risk']) {
      expect(contract.templates.has(type)).toBe(true);
    }
  });

  test('accepts a project page written in the draft format', () => {
    const validation = validateCanonicalPageTemplate('projects/example', VALID_PROJECT, PERSONAL_PACK);
    expect(validation).not.toBeNull();
    expect(validation?.findings).toEqual([]);
  });

  test('reports missing schema fields and body structure', () => {
    const validation = validateCanonicalPageTemplate(
      'projects/incomplete',
      '---\ntype: project\ntitle: Incomplete\n---\n\n# Incomplete\n',
      PERSONAL_PACK,
    );
    expect(validation).not.toBeNull();
    const codes = new Set(validation?.findings.map((finding) => finding.code));
    expect(codes.has('MISSING_FIELD')).toBe(true);
    expect(codes.has('MISSING_HEADING')).toBe(true);
    expect(codes.has('MISSING_TIMELINE_MARKER')).toBe(true);
  });

  test('keeps template headings in English and requires Chinese body prose', () => {
    const validation = validateCanonicalPageTemplate(
      'projects/english-body',
      VALID_PROJECT
        .replace('当前状态说明。', 'Current project state is still being reviewed.')
        .replace('## Open Questions', '## 待解决问题'),
      PERSONAL_PACK,
    );
    expect(validation?.findings.some((finding) => finding.code === 'BODY_LANGUAGE_MISMATCH')).toBe(true);
    expect(validation?.findings.some((finding) => finding.code === 'MISSING_HEADING' && finding.heading === 'Open Questions')).toBe(true);
  });

  test('uses the runtime timeline line format', () => {
    const validation = validateCanonicalPageTemplate(
      'projects/bad-timeline',
      VALID_PROJECT.replace(
        '- **2026-08-05** | 项目模板合同已启用。[Source: 测试]',
        '- 2026-08-05 | 来源 - 项目模板合同已启用。',
      ),
      PERSONAL_PACK,
    );
    expect(validation?.findings.some((finding) => finding.code === 'INVALID_TIMELINE_FORMAT')).toBe(true);
  });

  test('preserves the original language in raw evidence sections', () => {
    const validation = validateCanonicalPageTemplate(
      'projects/raw-evidence-language',
      VALID_PROJECT.replace(
        '## Open Questions',
        '## Evidence\n\nOriginal English quotation that must remain verbatim.\n\n## Open Questions',
      ),
      PERSONAL_PACK,
    );
    expect(validation?.findings.some((finding) => finding.code === 'BODY_LANGUAGE_MISMATCH' && finding.heading === 'Evidence')).toBe(false);
  });

  test('enforces core frontmatter enum values from the draft', () => {
    const validation = validateCanonicalPageTemplate(
      'projects/invalid-scope',
      VALID_PROJECT.replace('scope: private', 'scope: everywhere'),
      PERSONAL_PACK,
    );
    expect(validation?.findings.some((finding) => finding.code === 'INVALID_FIELD_VALUE' && finding.field === 'scope')).toBe(true);
  });

  test('defaults to strict for client-first remote writes without a local vault', async () => {
    await expect(resolveTemplateContractMode({
      getConfig: async () => undefined,
    }, { remote: true })).resolves.toBe('strict');
  });

  test('defaults to strict when a local vault is configured', async () => {
    await expect(resolveTemplateContractMode({
      getConfig: async (key: string) => key === 'sync.repo_path' ? process.cwd() : undefined,
    }, { remote: false })).resolves.toBe('strict');
  });

  test('keeps trusted local DB-only maintenance off by default', async () => {
    await expect(resolveTemplateContractMode({
      getConfig: async () => undefined,
    }, { remote: false })).resolves.toBe('off');
  });
});
