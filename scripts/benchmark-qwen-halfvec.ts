/**
 * Company Qwen3-VL 2048d storage-quality gate.
 *
 * This is intentionally an operator-run benchmark, not a unit test: it sends
 * a small, non-sensitive bilingual fixture to the internal embedding server.
 * It compares the model's native FP32 vectors with pgvector halfvec storage
 * (exact and HNSW retrieval) before a new Supabase brain is provisioned.
 *
 * Run:
 *   bun scripts/benchmark-qwen-halfvec.ts
 *
 * Optional overrides:
 *   QWEN_VLLM_BASE_URL=http://host:8000/v1
 *   QWEN_VLLM_MODEL=./models/Qwen3-VL-Embedding-2B
 */

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';

const DIMENSIONS = 2048;
const TOP_K = 5;
const BASE_URL = (process.env.QWEN_VLLM_BASE_URL ?? 'http://192.168.70.249:8000/v1').replace(/\/$/, '');
const MODEL = process.env.QWEN_VLLM_MODEL ?? './models/Qwen3-VL-Embedding-2B';

const DOCUMENTS = [
  ['budget', 'The finance team approved a quarterly cloud budget and tracks GPU inference costs, invoice variance, and monthly spend alerts.'],
  ['incident', 'The platform incident review covers database connection exhaustion, retry backoff, alert ownership, and a recovery timeline.'],
  ['hiring', 'The engineering hiring plan lists backend interviews, candidate feedback, role leveling, and an onboarding schedule.'],
  ['retrieval', 'The knowledge search design combines semantic embeddings, keyword retrieval, reciprocal-rank fusion, and a cross-encoder reranker.'],
  ['security', 'The security policy keeps confidential documents inside the private network and prohibits sending customer data to public AI providers.'],
  ['product', 'The product roadmap prioritizes image search, document ingestion, multilingual retrieval, and agent-facing knowledge tools.'],
  ['release', 'The release checklist requires migrations, type checking, regression tests, rollback notes, and production monitoring.'],
  ['support', 'Support triage groups customer reports by severity, reproduces defects, assigns owners, and communicates resolution status.'],
  ['供应链', '供应链团队跟踪采购合同、交货周期、库存预警和供应商绩效，确保关键零部件按时到货。'],
  ['会议纪要', '会议纪要记录了项目负责人、待办事项、决策结论和下次评审日期，方便团队后续追踪。'],
  ['检索质量', '检索质量评估使用标注问题集，比较召回率、MRR、nDCG 和 reranker 对前排结果的影响。'],
  ['模型部署', '内网模型部署包含 GPU 容量规划、vLLM 服务健康检查、版本管理和访问控制。'],
  ['隐私', '隐私方案要求文本、图片和向量都在公司内网处理，日志中不得出现客户身份信息。'],
  ['图片搜索', '图片搜索通过视觉向量匹配相似图片，也可以用文字描述查找含有指定物体或场景的图像。'],
  ['数据库迁移', '数据库迁移需要先验证 pgvector 版本，再创建索引、备份数据并提供可回滚的执行步骤。'],
  ['知识库', '知识库同步从 Markdown 文档提取分块、标签、链接和嵌入，供 Agent 回答问题时检索。'],
] as const;

const QUERIES = [
  ['How do we prevent confidential data from leaving the company network?', ['security', '隐私']],
  ['What should a safe production release include?', ['release', '数据库迁移']],
  ['How is semantic search evaluated?', ['retrieval', '检索质量']],
  ['How do we monitor GPU model serving?', ['模型部署', 'budget']],
  ['How can an agent find information from Markdown notes?', ['知识库', 'retrieval']],
  ['如何避免客户数据发送到外部模型？', ['隐私', 'security']],
  ['图片检索怎样支持以图搜图和文字搜图？', ['图片搜索', 'product']],
  ['数据库升级前应该检查哪些内容？', ['数据库迁移', 'release']],
  ['供应链风险应该关注什么？', ['供应链']],
  ['会议结束后如何追踪决策和待办？', ['会议纪要']],
] as const;

type Ranking = string[];

function pgVectorLiteral(vector: readonly number[]): string {
  return `[${vector.map(value => Number(value).toFixed(8)).join(',')}]`;
}

function dcg(ranking: Ranking, relevant: readonly string[]): number {
  const relevantSet = new Set(relevant);
  return ranking.reduce((total, id, index) => total + (relevantSet.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
}

function metrics(rankings: Ranking[]): { recallAt5: number; mrr: number; ndcgAt5: number } {
  let recall = 0;
  let reciprocalRank = 0;
  let ndcg = 0;
  for (let i = 0; i < rankings.length; i++) {
    const relevant = QUERIES[i][1];
    const rank = rankings[i];
    const first = rank.findIndex(id => relevant.includes(id as never));
    if (first >= 0) {
      recall++;
      reciprocalRank += 1 / (first + 1);
    }
    const ideal = Array.from({ length: Math.min(TOP_K, relevant.length) }, () => relevant[0]);
    ndcg += dcg(rank, relevant) / dcg(ideal, relevant);
  }
  return {
    recallAt5: recall / rankings.length,
    mrr: reciprocalRank / rankings.length,
    ndcgAt5: ndcg / rankings.length,
  };
}

function meanTopKOverlap(reference: Ranking[], candidate: Ranking[]): number {
  return reference.reduce((total, ranking, index) => {
    const candidateSet = new Set(candidate[index]);
    return total + ranking.filter(id => candidateSet.has(id)).length / TOP_K;
  }, 0) / reference.length;
}

async function embed(texts: readonly string[]): Promise<number[][]> {
  const response = await fetch(`${BASE_URL}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Qwen embedding request failed (${response.status}): ${body}`);
  const parsed = JSON.parse(body) as { data?: Array<{ embedding?: number[]; index?: number }> };
  const rows = [...(parsed.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (rows.length !== texts.length || rows.some(row => row.embedding?.length !== DIMENSIONS)) {
    throw new Error(`Expected ${texts.length} native ${DIMENSIONS}d embeddings, received ${rows.map(row => row.embedding?.length ?? 0).join(', ')}`);
  }
  return rows.map(row => row.embedding!);
}

async function main(): Promise<void> {
  const vectors = await embed([...DOCUMENTS.map(([, text]) => text), ...QUERIES.map(([query]) => query)]);
  const documentVectors = vectors.slice(0, DOCUMENTS.length);
  const queryVectors = vectors.slice(DOCUMENTS.length);

  const db = new PGlite({ extensions: { vector } });
  try {
    await db.exec(`
      CREATE EXTENSION vector;
      CREATE TABLE fp32_docs (id text primary key, embedding vector(${DIMENSIONS}) not null);
      CREATE TABLE fp16_docs (id text primary key, embedding halfvec(${DIMENSIONS}) not null);
    `);
    for (let i = 0; i < DOCUMENTS.length; i++) {
      const id = DOCUMENTS[i][0];
      const literal = pgVectorLiteral(documentVectors[i]);
      await db.query('INSERT INTO fp32_docs VALUES ($1, $2::vector)', [id, literal]);
      await db.query(`INSERT INTO fp16_docs VALUES ($1, $2::halfvec(${DIMENSIONS}))`, [id, literal]);
    }
    await db.exec('CREATE INDEX fp16_docs_hnsw ON fp16_docs USING hnsw (embedding halfvec_cosine_ops);');

    const fp32Rankings: Ranking[] = [];
    const fp16ExactRankings: Ranking[] = [];
    const fp16HnswRankings: Ranking[] = [];
    for (const vectorValues of queryVectors) {
      const literal = pgVectorLiteral(vectorValues);
      const fp32 = await db.query<{ id: string }>('SELECT id FROM fp32_docs ORDER BY embedding <=> $1::vector LIMIT $2', [literal, TOP_K]);
      const fp16Exact = await db.query<{ id: string }>(`SELECT id FROM fp16_docs ORDER BY embedding <=> $1::halfvec(${DIMENSIONS}) LIMIT $2`, [literal, TOP_K]);
      await db.exec('SET enable_seqscan = off;');
      const fp16Hnsw = await db.query<{ id: string }>(`SELECT id FROM fp16_docs ORDER BY embedding <=> $1::halfvec(${DIMENSIONS}) LIMIT $2`, [literal, TOP_K]);
      await db.exec('SET enable_seqscan = on;');
      fp32Rankings.push(fp32.rows.map(row => row.id));
      fp16ExactRankings.push(fp16Exact.rows.map(row => row.id));
      fp16HnswRankings.push(fp16Hnsw.rows.map(row => row.id));
    }

    const fp32 = metrics(fp32Rankings);
    const halfvecExact = metrics(fp16ExactRankings);
    const halfvecHnsw = metrics(fp16HnswRankings);
    const report = {
      model: MODEL,
      dimensions: DIMENSIONS,
      queries: QUERIES.length,
      fp32,
      halfvec_exact: halfvecExact,
      halfvec_hnsw: halfvecHnsw,
      top5_overlap_fp32_vs_halfvec_exact: meanTopKOverlap(fp32Rankings, fp16ExactRankings),
      top5_overlap_fp32_vs_halfvec_hnsw: meanTopKOverlap(fp32Rankings, fp16HnswRankings),
    };
    console.log(JSON.stringify(report, null, 2));

    const maxLoss = 0.02;
    const exactLoss = fp32.ndcgAt5 - halfvecExact.ndcgAt5;
    const hnswLoss = fp32.ndcgAt5 - halfvecHnsw.ndcgAt5;
    const hnswOverlap = report.top5_overlap_fp32_vs_halfvec_hnsw;
    if (exactLoss > maxLoss || hnswLoss > maxLoss || hnswOverlap < 0.98) {
      throw new Error(
        `QUALITY_GATE_FAILED: nDCG@5 loss exact=${exactLoss.toFixed(4)}, hnsw=${hnswLoss.toFixed(4)}, ` +
        `HNSW Top-5 overlap=${hnswOverlap.toFixed(4)}. Do not provision halfvec storage until the benchmark is investigated.`,
      );
    }
    console.log('QUALITY_GATE_PASSED: native Qwen 2048d halfvec retrieval is within the configured tolerance.');
  } finally {
    await db.close();
  }
}

await main();
