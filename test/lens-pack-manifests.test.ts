// v0.41 T4 — bundled lens pack manifest smoke tests.
//
// One test file covers all 4 packs (creator, investor, engineer, everything)
// because each test boils down to "manifest parses + declares the expected
// shape." Splitting per-pack would 4x the boilerplate without adding signal.
//
// Pinned contracts:
//   - All 4 YAMLs parse via parseSchemaPackManifest without error
//   - Each pack registered in BUNDLED (loadPackManifestByName resolves)
//   - Each pack declares the expected page_types, phases, calibration_domains
//   - extends chain resolves through registry without depth error
//   - voltmind-everything unions all three lens packs' contributions
//   - Calibration domain aggregator is the closed AggregatorKind enum on every entry

import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  parseSchemaPackManifest,
  parseYamlMini,
  AGGREGATOR_KINDS,
  type SchemaPackManifest,
} from '../src/core/schema-pack/index.ts';

const PACK_NAMES = [
  'voltmind-creator',
  'voltmind-investor',
  'voltmind-engineer',
  'voltmind-everything',
] as const;

const here = dirname(fileURLToPath(import.meta.url));
const baseDir = join(here, '..', 'src', 'core', 'schema-pack', 'base');

function loadPack(name: string): SchemaPackManifest {
  const p = join(baseDir, `${name}.yaml`);
  if (!existsSync(p)) {
    throw new Error(`bundled pack not found at ${p}`);
  }
  const raw = readFileSync(p, 'utf-8');
  const parsed = parseYamlMini(raw);
  return parseSchemaPackManifest(parsed, { path: p });
}

describe('v0.41 T4: all 4 bundled lens packs parse cleanly', () => {
  for (const name of PACK_NAMES) {
    test(`${name}.yaml parses via parseSchemaPackManifest without error`, () => {
      const pack = loadPack(name);
      expect(pack.name).toBe(name);
      expect(pack.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(pack.api_version).toBe('voltmind-schema-pack-v1');
    });
  }
});

describe('v0.41 T4: bundled registry includes lens packs', () => {
  test('load-active.ts BUNDLED array source includes the 4 lens pack names', () => {
    const loadActiveSrc = readFileSync(
      join(here, '..', 'src', 'core', 'schema-pack', 'load-active.ts'),
      'utf-8',
    );
    for (const name of PACK_NAMES) {
      expect(loadActiveSrc).toContain(`'${name}'`);
    }
  });
});

describe('VoltMind company core manifest shape', () => {
  const pack = loadPack('voltmind-company-core');

  test('extends voltmind-base and keeps roles as fields rather than orgs/roles pages', () => {
    expect(pack.extends).toBe('voltmind-base');
    const org = pack.page_types.find((p) => p.name === 'org');
    expect(org?.path_prefixes).toEqual(['orgs/']);
    expect(pack.page_types.some((p) => p.name === 'role')).toBe(false);
    expect(pack.page_types.some((p) => p.path_prefixes.includes('orgs/roles/'))).toBe(false);
  });

  test('declares personal/company core work objects', () => {
    const typeNames = pack.page_types.map((p) => p.name);
    for (const name of [
      'ontology',
      'inbox',
      'daily',
      'org',
      'workstream',
      'project',
      'idea',
      'meeting',
      'artifact',
      'decision',
      'commitment',
      'action',
      'risk',
      'policy',
      'source',
      'contribution_candidate',
      'private',
    ]) {
      expect(typeNames).toContain(name);
    }
  });

  test('declares Phase 0 policy directory as singular policy/', () => {
    const policy = pack.page_types.find((p) => p.name === 'policy');
    expect(policy?.path_prefixes).toEqual(['policy/']);
    const filing = pack.filing_rules.find((r) => r.kind === 'policy');
    expect(filing?.directory).toBe('policy/');
  });

  test('draft scaffold declares Phase 0 policy runtime enums', () => {
    const raw = readFileSync(
      join(here, '..', 'docs', 'drafts', 'personal-brain-scaffold', '.system', 'policy-config.json'),
      'utf-8',
    );
    const config = JSON.parse(raw);
    expect(config.publish_levels).toEqual([
      'never',
      'candidate',
      'user_approved',
      'team_reviewed',
      'company_state',
    ]);
    expect(config.sensitivity).toEqual(['public', 'internal', 'confidential', 'restricted']);
    expect(config.action_risk).toEqual(['low', 'medium', 'high', 'restricted']);
  });

  test('state objects live under state/ rather than root directories', () => {
    const byName = Object.fromEntries(pack.page_types.map((p) => [p.name, p.path_prefixes]));
    expect(byName.decision).toEqual(['state/decisions/']);
    expect(byName.commitment).toEqual(['state/commitments/']);
    expect(byName.action).toEqual(['state/actions/']);
    expect(byName.risk).toEqual(['state/risks/']);
    for (const rootPrefix of ['decisions/', 'commitments/', 'actions/', 'risks/']) {
      expect(pack.page_types.some((p) => p.path_prefixes.includes(rootPrefix))).toBe(false);
    }
  });

  test('declares ideas as raw pre-project thinking with exact-phrasing guidance', () => {
    const idea = pack.page_types.find((p) => p.name === 'idea');
    expect(idea?.primitive).toBe('concept');
    expect(idea?.path_prefixes).toContain('ideas/');
    expect(idea?.extractable).toBe(true);
    expect(idea?.aliases).toContain('product-thought');
    const filing = pack.filing_rules.find((r) => r.kind === 'idea');
    expect(filing?.directory).toBe('ideas/');
    expect(filing?.description).toContain('Preserve the user');
  });

  test('declares relationship verbs for core graph materialization', () => {
    const linkNames = pack.link_types.map((l) => l.name);
    for (const name of ['member_of', 'owns', 'accountable_for', 'decided_by', 'commits_to', 'assigned_to', 'blocks', 'mitigates', 'governed_by', 'evidence_for']) {
      expect(linkNames).toContain(name);
    }
  });

  test('declares core frontmatter graph fields for project pages', () => {
    expect(pack.frontmatter_links).toContainEqual({
      page_type: 'project',
      fields: ['source_refs'],
      link_type: 'evidence_for',
    });
    expect(pack.frontmatter_links).toContainEqual({
      page_type: 'project',
      fields: ['related_entities'],
      link_type: 'related_to',
    });
  });

  test('declares action orchestration modes and action relation fields', () => {
    const action = pack.page_types.find((p) => p.name === 'action');
    expect(action?.aliases).toEqual(expect.arrayContaining([
      'manual_action',
      'agent_assisted_action',
      'agent_executable_action',
      'agent_scheduled_action',
      'agent_watch_action',
    ]));
    expect(pack.frontmatter_links).toContainEqual({
      page_type: 'action',
      fields: ['related_project', 'related_projects'],
      link_type: 'discussed_in',
    });
    expect(pack.frontmatter_links).toContainEqual({
      page_type: 'action',
      fields: ['related_workstream'],
      link_type: 'discussed_in',
    });
    expect(pack.frontmatter_links).toContainEqual({
      page_type: 'action',
      fields: ['context_refs'],
      link_type: 'evidence_for',
    });
  });
});

describe('v0.41 T4: voltmind-creator manifest shape', () => {
  const pack = loadPack('voltmind-creator');

  test('extends voltmind-base', () => {
    expect(pack.extends).toBe('voltmind-base');
  });

  test('declares atom page type (NEW to base)', () => {
    const atom = pack.page_types.find((p) => p.name === 'atom');
    expect(atom).toBeDefined();
    expect(atom?.primitive).toBe('concept');
    expect(atom?.path_prefixes).toContain('atoms/');
    expect(atom?.extractable).toBe(false); // leaf node, not source for further extraction
    expect(atom?.expert_routing).toBe(false);
  });

  test('declares extract_atoms + synthesize_concepts phases', () => {
    expect(pack.phases).toContain('extract_atoms');
    expect(pack.phases).toContain('synthesize_concepts');
  });

  test('declares concept_themes calibration domain with cluster_summary aggregator', () => {
    const themes = pack.calibration_domains!.find((d) => d.name === 'concept_themes');
    expect(themes).toBeDefined();
    expect(themes?.aggregator).toBe('cluster_summary');
    expect(themes?.page_types).toContain('concept');
  });

  test('filing rules for atom + concept include canonical paths', () => {
    const atomRule = pack.filing_rules.find((r) => r.kind === 'atom');
    expect(atomRule?.directory).toBe('atoms/');
    const conceptRule = pack.filing_rules.find((r) => r.kind === 'concept');
    expect(conceptRule?.directory).toBe('concepts/');
  });
});

describe('v0.41 T4: voltmind-investor manifest shape', () => {
  const pack = loadPack('voltmind-investor');

  test('extends voltmind-base + borrows deal/person/company/yc', () => {
    expect(pack.extends).toBe('voltmind-base');
    const borrowEntry = pack.borrow_from.find((b) => b.pack === 'voltmind-base');
    expect(borrowEntry).toBeDefined();
    expect(borrowEntry?.types).toEqual(expect.arrayContaining(['deal', 'person', 'company', 'yc']));
  });

  test('declares thesis + bet_resolution_log page types', () => {
    const thesis = pack.page_types.find((p) => p.name === 'thesis');
    expect(thesis).toBeDefined();
    expect(thesis?.primitive).toBe('concept');
    expect(thesis?.extractable).toBe(true);

    const bet = pack.page_types.find((p) => p.name === 'bet_resolution_log');
    expect(bet).toBeDefined();
    expect(bet?.primitive).toBe('temporal');
  });

  test('declares NO new cycle phases (consumes existing pipeline)', () => {
    expect(pack.phases).toEqual([]);
  });

  test('declares 3 calibration domains (deal_success + founder_evaluation + market_call)', () => {
    const names = pack.calibration_domains!.map((d) => d.name).sort();
    expect(names).toEqual(['deal_success', 'founder_evaluation', 'market_call']);
  });

  test('every calibration_domain aggregator is in the closed AggregatorKind enum', () => {
    for (const d of pack.calibration_domains!) {
      expect(AGGREGATOR_KINDS).toContain(d.aggregator);
    }
  });

  test('market_call uses weighted_brier (high-conviction-rare-event semantics)', () => {
    const mc = pack.calibration_domains!.find((d) => d.name === 'market_call');
    expect(mc?.aggregator).toBe('weighted_brier');
  });

  test('filing rules cover deal + thesis + bet_resolution_log + investor', () => {
    const kinds = pack.filing_rules.map((r) => r.kind).sort();
    expect(kinds).toEqual(['bet_resolution_log', 'deal', 'investor', 'thesis']);
  });
});

describe('v0.41 T4: voltmind-engineer manifest shape', () => {
  const pack = loadPack('voltmind-engineer');

  test('extends voltmind-base + borrows code/project', () => {
    expect(pack.extends).toBe('voltmind-base');
    const borrowEntry = pack.borrow_from.find((b) => b.pack === 'voltmind-base');
    expect(borrowEntry?.types).toEqual(expect.arrayContaining(['code', 'project']));
  });

  test('declares ONLY learning page type (D8-C bridge-only)', () => {
    expect(pack.page_types.length).toBe(1);
    expect(pack.page_types[0].name).toBe('learning');
    expect(pack.page_types[0].primitive).toBe('annotation');
  });

  test('declares NO new cycle phases (gstack bridge is daemon-side IngestionSource)', () => {
    expect(pack.phases).toEqual([]);
  });

  test('declares 3 calibration domains (architecture_calls + effort_estimates + risk_assessment)', () => {
    const names = pack.calibration_domains!.map((d) => d.name).sort();
    expect(names).toEqual(['architecture_calls', 'effort_estimates', 'risk_assessment']);
  });

  test('effort_estimates uses weighted_brier (small-vs-big estimate scaling)', () => {
    const ee = pack.calibration_domains!.find((d) => d.name === 'effort_estimates');
    expect(ee?.aggregator).toBe('weighted_brier');
  });

  test('every calibration_domain aggregator is in the closed AggregatorKind enum', () => {
    for (const d of pack.calibration_domains!) {
      expect(AGGREGATOR_KINDS).toContain(d.aggregator);
    }
  });
});

describe('v0.41 T4: voltmind-everything meta-pack shape', () => {
  const pack = loadPack('voltmind-everything');

  test('extends voltmind-investor (chain head)', () => {
    expect(pack.extends).toBe('voltmind-investor');
  });

  test('borrows from voltmind-creator + voltmind-engineer', () => {
    const borrowedPacks = pack.borrow_from.map((b) => b.pack).sort();
    expect(borrowedPacks).toEqual(['voltmind-creator', 'voltmind-engineer']);
  });

  test('borrows atom from creator and learning from engineer', () => {
    const creatorBorrow = pack.borrow_from.find((b) => b.pack === 'voltmind-creator');
    expect(creatorBorrow?.types).toContain('atom');
    const engineerBorrow = pack.borrow_from.find((b) => b.pack === 'voltmind-engineer');
    expect(engineerBorrow?.types).toContain('learning');
  });

  test('declares NO own page_types (everything via extends + borrow)', () => {
    expect(pack.page_types).toEqual([]);
  });

  test('explicitly re-declares phases from creator (borrow_from does NOT borrow phases)', () => {
    expect(pack.phases).toEqual(['extract_atoms', 'synthesize_concepts']);
  });

  test('explicitly unions ALL 7 lens calibration domains', () => {
    const names = pack.calibration_domains!.map((d) => d.name).sort();
    expect(names).toEqual([
      'architecture_calls',
      'concept_themes',
      'deal_success',
      'effort_estimates',
      'founder_evaluation',
      'market_call',
      'risk_assessment',
    ]);
  });

  test('every meta-pack calibration_domain aggregator is in the closed enum', () => {
    for (const d of pack.calibration_domains!) {
      expect(AGGREGATOR_KINDS).toContain(d.aggregator);
    }
  });

  test('aggregator selection matches per-pack declarations (cross-pack consistency)', () => {
    const byName = Object.fromEntries(pack.calibration_domains!.map((d) => [d.name, d.aggregator]));
    // From investor
    expect(byName.deal_success).toBe('scalar_brier');
    expect(byName.market_call).toBe('weighted_brier');
    expect(byName.founder_evaluation).toBe('scalar_brier');
    // From creator
    expect(byName.concept_themes).toBe('cluster_summary');
    // From engineer
    expect(byName.architecture_calls).toBe('scalar_brier');
    expect(byName.effort_estimates).toBe('weighted_brier');
    expect(byName.risk_assessment).toBe('scalar_brier');
  });
});
