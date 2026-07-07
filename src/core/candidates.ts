import { createHash } from 'crypto';
import type { BrainEngine } from './engine.ts';
import { OperationError } from './operations.ts';
import { readoutProvenance } from './readout-provenance.ts';

export interface CandidateRow {
  id: number;
  source_id: string;
  page_slug: string;
  content_hash: string;
  prompt_version: string;
  wave_version: string;
  proposed_at: string;
  proposal_run_id: string;
  status: 'pending' | 'accepted' | 'rejected' | 'superseded';
  claim_text: string;
  kind: string;
  holder: string;
  weight: number;
  domain: string | null;
  dedup_against_fence_rows: unknown;
  model_id: string;
  acted_at: string | null;
  acted_by: string | null;
  promoted_row_num: number | null;
  predicted_brier: number | null;
  predicted_brier_bucket_n: number | null;
}

export interface CandidateEnvelope extends CandidateRow {
  candidate_id: number;
  state: 'pending' | 'applied' | 'rejected' | 'expired';
  provenance: ReturnType<typeof readoutProvenance>;
}

const PROMPT_VERSION = 'voltmind:mvp-provenance-candidate-v1';
const MODEL_ID = 'explicit-source';

function sha8(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

function rowToCandidate(row: Record<string, unknown>): CandidateEnvelope {
  const candidate = {
    id: Number(row.id),
    source_id: String(row.source_id),
    page_slug: String(row.page_slug),
    content_hash: String(row.content_hash),
    prompt_version: String(row.prompt_version),
    wave_version: String(row.wave_version ?? ''),
    proposed_at: String(row.proposed_at),
    proposal_run_id: String(row.proposal_run_id),
    status: String(row.status) as CandidateRow['status'],
    claim_text: String(row.claim_text),
    kind: String(row.kind),
    holder: String(row.holder),
    weight: Number(row.weight),
    domain: row.domain == null ? null : String(row.domain),
    dedup_against_fence_rows: row.dedup_against_fence_rows ?? null,
    model_id: String(row.model_id),
    acted_at: row.acted_at == null ? null : String(row.acted_at),
    acted_by: row.acted_by == null ? null : String(row.acted_by),
    promoted_row_num: row.promoted_row_num == null ? null : Number(row.promoted_row_num),
    predicted_brier: row.predicted_brier == null ? null : Number(row.predicted_brier),
    predicted_brier_bucket_n: row.predicted_brier_bucket_n == null ? null : Number(row.predicted_brier_bucket_n),
  };
  return {
    ...candidate,
    candidate_id: candidate.id,
    state: candidate.status === 'accepted'
      ? 'applied'
      : candidate.status === 'superseded'
        ? 'expired'
        : candidate.status,
    provenance: readoutProvenance({
      source_id: candidate.source_id,
      citation: candidate.domain,
      confidence: candidate.weight,
      created_by: candidate.model_id,
      derived_from: candidate.proposal_run_id,
    }),
  };
}

export async function listCandidates(
  engine: BrainEngine,
  opts: { status?: string; sourceId?: string; limit?: number },
): Promise<CandidateEnvelope[]> {
  const status = opts.status ?? 'pending';
  const sourceId = opts.sourceId ?? null;
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT * FROM take_proposals
      WHERE ($1::text IS NULL OR status = $1)
        AND ($2::text IS NULL OR source_id = $2)
      ORDER BY proposed_at DESC
      LIMIT $3`,
    [status === 'all' ? null : status, sourceId, limit],
  );
  return rows.map(rowToCandidate);
}

export async function getCandidate(engine: BrainEngine, candidateId: number): Promise<CandidateEnvelope> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT * FROM take_proposals WHERE id = $1 LIMIT 1`,
    [candidateId],
  );
  if (rows.length === 0) throw new OperationError('invalid_params', `Candidate not found: ${candidateId}`);
  return rowToCandidate(rows[0]!);
}

export async function proposeExtractionCandidate(
  engine: BrainEngine,
  opts: {
    sourceId: string;
    pageSlug: string;
    claim: string;
    citation: string;
    confidence?: number;
    holder?: string;
    kind?: string;
    dryRun?: boolean;
  },
): Promise<{ dry_run?: true; candidate: CandidateEnvelope | Omit<CandidateEnvelope, 'id' | 'candidate_id'> & { id: null; candidate_id: null } }> {
  if (!opts.sourceId) throw new OperationError('invalid_params', 'source_id is required.');
  if (!opts.pageSlug) throw new OperationError('invalid_params', 'page_slug is required.');
  if (!opts.claim) throw new OperationError('invalid_params', 'claim is required.');
  if (!opts.citation) throw new OperationError('invalid_params', 'citation is required.');
  const confidence = Math.max(0, Math.min(1, opts.confidence ?? 0.5));
  const contentHash = sha8(`${opts.sourceId}\n${opts.pageSlug}\n${opts.claim}\n${opts.citation}`);
  const runId = `candidate-${contentHash}`;
  const base = {
    source_id: opts.sourceId,
    page_slug: opts.pageSlug,
    content_hash: contentHash,
    prompt_version: PROMPT_VERSION,
    wave_version: 'mvp',
    proposed_at: new Date().toISOString(),
    proposal_run_id: runId,
    status: 'pending' as const,
    claim_text: opts.claim,
    kind: opts.kind ?? 'fact',
    holder: opts.holder ?? 'brain',
    weight: confidence,
    domain: opts.citation,
    dedup_against_fence_rows: null,
    model_id: MODEL_ID,
    acted_at: null,
    acted_by: null,
    promoted_row_num: null,
    predicted_brier: null,
    predicted_brier_bucket_n: null,
  };
  if (opts.dryRun) {
    return {
      dry_run: true,
      candidate: {
        ...base,
        id: null,
        candidate_id: null,
        state: 'pending',
        provenance: readoutProvenance({
          source_id: opts.sourceId,
          citation: opts.citation,
          confidence,
          created_by: MODEL_ID,
          derived_from: runId,
        }),
      },
    };
  }
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `INSERT INTO take_proposals (
       source_id, page_slug, content_hash, prompt_version, wave_version,
       proposal_run_id, status, claim_text, kind, holder, weight, domain,
       dedup_against_fence_rows, model_id
     ) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10,$11,$12::jsonb,$13)
     ON CONFLICT (source_id, page_slug, content_hash, prompt_version)
     DO UPDATE SET status = 'pending', proposed_at = now()
     RETURNING *`,
    [
      opts.sourceId,
      opts.pageSlug,
      contentHash,
      PROMPT_VERSION,
      'mvp',
      runId,
      opts.claim,
      opts.kind ?? 'fact',
      opts.holder ?? 'brain',
      confidence,
      opts.citation,
      JSON.stringify([]),
      MODEL_ID,
    ],
  );
  return { candidate: rowToCandidate(rows[0]!) };
}

export async function previewCandidateApply(engine: BrainEngine, candidateId: number): Promise<Record<string, unknown>> {
  const c = await getCandidate(engine, candidateId);
  const row = `| ${c.claim_text} | ${c.kind} | ${c.holder} | ${c.weight.toFixed(2)} | ${c.domain ?? ''} | | | |`;
  return {
    candidate_id: c.id,
    status: c.status,
    state: c.state,
    target: { source_id: c.source_id, page_slug: c.page_slug },
    diff: `+ ${row}`,
    warnings: c.status !== 'pending' ? [`candidate is ${c.status}`] : [],
    provenance: c.provenance,
  };
}

export async function applyCandidate(
  engine: BrainEngine,
  opts: { candidateId: number; sourceId: string; citation: string; confirm: boolean },
): Promise<Record<string, unknown>> {
  if (!opts.confirm) throw new OperationError('permission_denied', 'apply_candidate requires confirm=true.');
  if (!opts.sourceId) throw new OperationError('invalid_params', 'source_id is required.');
  if (!opts.citation) throw new OperationError('invalid_params', 'citation is required.');
  const c = await getCandidate(engine, opts.candidateId);
  if (c.status !== 'pending') throw new OperationError('invalid_params', `Candidate ${c.id} is ${c.status}.`);
  if (c.source_id !== opts.sourceId) {
    throw new OperationError('invalid_params', `source_id mismatch: candidate is ${c.source_id}.`);
  }
  const pageRows = await engine.executeRaw<{ id: number | string; max_row: number | string | null }>(
    `SELECT p.id, COALESCE(MAX(t.row_num), 0) AS max_row
       FROM pages p
       LEFT JOIN takes t ON t.page_id = p.id
      WHERE p.source_id = $1 AND p.slug = $2
      GROUP BY p.id
      LIMIT 1`,
    [c.source_id, c.page_slug],
  );
  if (pageRows.length === 0) throw new OperationError('page_not_found', `Page not found: ${c.source_id}:${c.page_slug}`);
  const pageRow = pageRows[0]!;
  const pageId = Number(pageRow.id);
  const rowNum = Number(pageRow.max_row ?? 0) + 1;
  await engine.addTakesBatch([{
    page_id: pageId,
    row_num: rowNum,
    claim: c.claim_text,
    kind: c.kind,
    holder: c.holder,
    weight: c.weight,
    source: opts.citation,
    active: true,
  }]);
  await engine.executeRaw(
    `UPDATE take_proposals
        SET status = 'accepted',
            acted_at = now(),
            acted_by = 'voltmind:apply_candidate',
            promoted_row_num = $2
      WHERE id = $1`,
    [c.id, rowNum],
  );
  return {
    candidate_id: c.id,
    applied: true,
    state: 'applied',
    target: { source_id: c.source_id, page_slug: c.page_slug, row_num: rowNum },
    path: 'takes_index',
    provenance: readoutProvenance({
      source_id: c.source_id,
      citation: opts.citation,
      confidence: c.weight,
      created_by: 'voltmind:apply_candidate',
      derived_from: `candidate:${c.id}`,
    }),
  };
}

export async function rejectCandidate(engine: BrainEngine, candidateId: number): Promise<Record<string, unknown>> {
  const c = await getCandidate(engine, candidateId);
  await engine.executeRaw(
    `UPDATE take_proposals
        SET status = 'rejected',
            acted_at = now(),
            acted_by = 'voltmind:reject_candidate'
      WHERE id = $1 AND status = 'pending'`,
    [candidateId],
  );
  const wasPending = c.status === 'pending';
  return {
    candidate_id: c.id,
    rejected: wasPending,
    state: wasPending ? 'rejected' : c.state,
    previous_status: c.status,
  };
}
