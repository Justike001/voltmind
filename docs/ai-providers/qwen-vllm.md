# Company Internal Qwen Embedding and Reranking

Use this guide for the company network deployment. It keeps embedding and
reranking traffic on the internal network; it is intentionally a clean-brain
setup, not an in-place migration guide.

## Verified deployment

| Capability | Internal endpoint | Served model | Runtime route |
| --- | --- | --- | --- |
| Text embedding | `http://192.168.70.249:8000` | `./models/Qwen3-VL-Embedding-2B` | `/v1/embeddings` |
| Image / mixed embedding | `http://192.168.70.249:8000` | `./models/Qwen3-VL-Embedding-2B` | `/v2/embed` |
| Reranking | `http://192.168.70.249:8003` | `Qwen3-VL-Reranker-2B` | `/v1/rerank` |

The embedding model emits its native **2048 dimensions**. Do not send
`dimensions`, `output_dimension`, or `input_type`: the deployed model rejects
dimension reduction and does not define input-type instructions.

Fresh VoltMind databases store all three retrieval columns in the same Qwen
space:

```sql
content_chunks.embedding             halfvec(2048)
content_chunks.embedding_image       halfvec(2048)
content_chunks.embedding_multimodal  halfvec(2048)
takes.embedding                      halfvec(2048)
```

`halfvec(2048)` is deliberate. pgvector HNSW only indexes plain `vector` up
to 2000 dimensions, while HNSW supports `halfvec` up to 4000 dimensions. The
small precision trade-off preserves the model's native width and avoids an
unindexed exact-scan database. Require pgvector **0.7 or newer** in Supabase
or Postgres. `voltmind init` checks this before issuing schema DDL and refuses
an older extension with an upgrade message.

The repository includes a reproducible, internal-only quality gate:

```bash
bun scripts/benchmark-qwen-halfvec.ts
```

It embeds a small bilingual non-sensitive corpus with the deployed Qwen model,
then compares FP32 exact retrieval, halfvec exact retrieval, and halfvec HNSW
for Recall@5, MRR, nDCG@5, and Top-5 overlap. The checked deployment passed
all three paths with identical scores; run it again after changing the server,
pgvector version, or index parameters.

## Create a new Supabase brain

This procedure assumes the existing database only contains disposable test
data. Create a new Supabase project/database instead of modifying an existing
brain.

```bash
voltmind config set provider_base_urls '{"qwen-vllm":"http://192.168.70.249:8000/v1","qwen-vllm-reranker":"http://192.168.70.249:8003/v1"}'

voltmind init --supabase \
  --embedding-model 'qwen-vllm:./models/Qwen3-VL-Embedding-2B' \
  --embedding-dimensions 2048

voltmind config set embedding_multimodal true
voltmind config set search.reranker.enabled true
voltmind config set search.reranker.model 'qwen-vllm-reranker:Qwen3-VL-Reranker-2B'
```

Do not set `search.unified_multimodal` yet. First import and build coverage:

```bash
voltmind import <brain-directory> --no-embed
voltmind embed --stale                 # chunks and takes
voltmind reindex --multimodal --yes    # text plus original image bytes
voltmind config set search.unified_multimodal true
```

For image rows, reindex reads `files.storage_path` beneath the current source
directory and sends the original bytes to Qwen. It deliberately refuses a
missing or out-of-root image path instead of substituting OCR text or a
filename. Run it from that source directory.

`embedding_model`, `embedding_dimensions`, and
`embedding_multimodal_model` are schema-contract fields in this mode. The
runtime rejects DB-only changes to them. A model or dimension switch requires
a new database (recommended) or clearing every vector-bearing table and doing
a complete reimport/re-embed; never mix vector spaces in one index.

For unattended setup, provide the Supabase connection string using the normal
`voltmind init --non-interactive --url ...` flow and keep the same embedding
arguments.

## Verify before importing real data

```bash
voltmind models
voltmind models doctor
voltmind doctor --json
```

Check the actual database schema once:

```sql
SELECT attname, format_type(atttypid, atttypmod)
FROM pg_attribute
WHERE attrelid = 'content_chunks'::regclass
  AND attname IN ('embedding', 'embedding_image', 'embedding_multimodal')
  AND NOT attisdropped
ORDER BY attname;
```

Every returned type must be `halfvec(2048)`. Then import and embed:

```bash
SELECT extversion FROM pg_extension WHERE extname = 'vector';
```

The extension must report `0.7.0` or newer. Also verify `takes.embedding` is
`halfvec(2048)` after migration v108. Use a small image-containing fixture to
exercise image-to-text retrieval before importing sensitive documents.

## Privacy boundary

The `qwen-vllm` and `qwen-vllm-reranker` recipes have no external fallback:
embedding and reranking failures surface as errors or retrieval fail-open
behavior; VoltMind does not resend those inputs to a public provider. Chat,
query-expansion, OCR, and enrichment are separate capabilities. Leave them
unset or configure company-internal services as well if their input may be
sensitive.

See the internal service Swagger pages for live model names and API shape:
[embedding :8000](http://192.168.70.249:8000/docs) and
[reranker :8003](http://192.168.70.249:8003/docs).
