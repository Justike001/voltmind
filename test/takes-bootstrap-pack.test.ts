import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';
import { takesBootstrapTypesFromPack } from '../src/core/schema-pack/takes-bootstrap.ts';

const baseDir = join(import.meta.dir, '../src/core/schema-pack/base');
const types = (name: string) => takesBootstrapTypesFromPack(loadPackFromFile(join(baseDir, `${name}.yaml`)));

describe('takes bootstrap bundled pack declarations', () => {
  test('base separates takes eligibility from facts extraction', () => {
    const pack = loadPackFromFile(join(baseDir, 'voltmind-base.yaml'));
    const eligible = takesBootstrapTypesFromPack(pack);
    expect([...eligible].sort()).toEqual(['atom', 'concept', 'writing']);
    expect(pack.page_types.find((type) => type.name === 'atom')?.extractable).toBe(false);
  });

  test('recommended uses canonical original, not the originals directory name', () => {
    const eligible = types('voltmind-recommended');
    expect(eligible.has('original')).toBe(true);
    expect(eligible.has('originals')).toBe(false);
  });

  test('lens packs explicitly preserve child-wins declarations', () => {
    expect(types('voltmind-creator').has('atom')).toBe(true);
    expect(types('voltmind-investor').has('thesis')).toBe(true);
    expect(types('voltmind-engineer').has('learning')).toBe(true);
  });

  test('standalone and company packs use a conservative prose set', () => {
    expect([...types('voltmind-personal-brain')].sort()).toEqual(['concept', 'idea', 'risk']);
    expect([...types('voltmind-company-core')].sort()).toEqual(['idea', 'risk']);
  });

  test('missing field defaults to ineligible', () => {
    expect(takesBootstrapTypesFromPack({ page_types: [{ name: 'custom' }] } as never).size).toBe(0);
  });
});
