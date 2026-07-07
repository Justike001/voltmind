export interface ReadoutProvenance {
  source_id: string | null;
  citation: string | null;
  confidence: number | null;
  created_by: string | null;
  derived_from: string | null;
}

export function readoutProvenance(input: Partial<ReadoutProvenance>): ReadoutProvenance {
  return {
    source_id: input.source_id ?? null,
    citation: input.citation ?? null,
    confidence: typeof input.confidence === 'number' ? input.confidence : null,
    created_by: input.created_by ?? null,
    derived_from: input.derived_from ?? null,
  };
}

export function withReadoutProvenance<T extends object>(
  row: T,
  provenance: Partial<ReadoutProvenance>,
): T & { provenance: ReadoutProvenance } {
  return {
    ...row,
    provenance: readoutProvenance(provenance),
  };
}
