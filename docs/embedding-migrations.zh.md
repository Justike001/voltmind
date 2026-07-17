# 在现有 brain 上切换 embedding 模型或维度

VoltMind 在 `content_chunks` 上用固定维度的 `vector(N)` 列保存 embeddings。如果你切换到不同维度的模型（例如 `text-embedding-3-large` 1536 → `voyage-multilingual-large-2` 2048，或者切回更小的模型如 `nomic-embed-text` 768），磁盘上的列类型不会自动改变。

`voltmind init` 和 `voltmind doctor` 都会检测这种情况，并拒绝静默继续。本文就是它们指向的操作配方。

## 为什么不自动做

切换维度需要：

1. 删除 HNSW vector index（pgvector 无法在 `ALTER COLUMN TYPE` 后保留它）。
2. 修改列类型。
3. 清除所有现有 embedding（旧向量在新空间里不可用）。
4. 重新 embedding 整个语料（50K 页面 brain 可能需要数小时，并根据模型产生 $1-100 API 成本）。
5. 有条件地重建索引（pgvector 的 HNSW 最多支持 2000 维；超过后必须用 exact scans）。

这不是升级时应该自动运行的事情。它是一个有意执行、成本较高的操作。只有当你确定想要新模型时再运行。

## Recipe — 对你的 brain 手动运行 `psql`

把 `<NEW_DIMS>` 替换成目标维度数。

```sql
BEGIN;

-- 1. Drop the HNSW index. It can't survive the column type change.
DROP INDEX IF EXISTS idx_chunks_embedding;

-- 2. Alter the column type. (You can DROP COLUMN + ADD COLUMN instead
--    if the existing data is already gone — same end state.)
ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(<NEW_DIMS>);

-- 3. Clear stale embeddings so they don't survive into the new space.
--    Either truncate (faster, drops all chunks) or null out (preserves
--    chunk text so re-embed regenerates without re-chunking):
UPDATE content_chunks SET embedding = NULL, embedded_at = NULL;

-- 4. Recreate the HNSW index ONLY IF dims <= 2000. Above that, leave it
--    indexless and rely on exact scans (voltmind searchVector handles this
--    automatically — search just gets slower, not broken).
-- For dims <= 2000 (e.g. 1024, 1536, 768):
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
  ON content_chunks USING hnsw (embedding vector_cosine_ops);
-- For dims > 2000 (e.g. 2048 Voyage 4 Large): skip step 4.

COMMIT;
```

然后更新 voltmind 的配置，让它知道新维度：

```bash
voltmind config set embedding_model <model>
voltmind config set embedding_dimensions <NEW_DIMS>
```

并重新 embedding 语料：

```bash
voltmind embed --stale
```

## PGLite（本地 brain）

同样的配方，但连接 embedded database 的方式不同：

```bash
voltmind config get database_url   # confirm engine: pglite
# Open a psql-equivalent — for PGLite, the easiest path is to write a small
# script that imports PGLiteEngine and runs the SQL via engine.executeRaw.
# Or migrate to Postgres temporarily (voltmind migrate --to supabase) if you
# want a real psql connection.
```

对大多数 PGLite 用户来说，如果语料足够小、重新同步比手写迁移更快，较简单的路径是**清空并重新初始化**：

```bash
mv ~/.voltmind/brain.pglite ~/.voltmind/brain.pglite.bak
voltmind init --pglite --embedding-dimensions <NEW_DIMS>
voltmind sync   # re-imports your brain repo from disk
```

## Verify

配方完成后，`voltmind doctor --fast` 应该报告绿色，`voltmind doctor`（full）应显示 check 8b 通过：

```
✓ embedding_provider     dim parity: config 768 / column vector(768) / live probe 768
```

如果没有，请带上 doctor 输出和你运行的 SQL 提 issue。

## v0.29+ 计划

`voltmind migrate-embedding-dim --to <N>` 是一个已跟踪 TODO。它会执行上面的配方，并带有进度报告和显式确认 gate。在它落地前，这份手动配方就是规范路径。
