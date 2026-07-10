import { describe, expect, test } from 'bun:test';
import { readoutProvenance, withReadoutProvenance } from '../src/core/readout-provenance.ts';

describe('readout provenance contract', () => {
  test('fills missing fields with null instead of invented values', () => {
    expect(readoutProvenance({ citation: 'Source: note' })).toEqual({
      source_id: null,
      citation: 'Source: note',
      confidence: null,
      created_by: null,
      derived_from: null,
    });
  });

  test('wraps readout rows with the shared provenance object', () => {
    expect(withReadoutProvenance({ id: 1, text: 'claim' }, { source_id: 'default', confidence: 0.8 })).toEqual({
      id: 1,
      text: 'claim',
      provenance: {
        source_id: 'default',
        citation: null,
        confidence: 0.8,
        created_by: null,
        derived_from: null,
      },
    });
  });
});
