/**
 * Leaf module holding the default embedding model + dimensions.
 *
 * Extracted so schema helpers (pglite-schema.ts, postgres-engine.ts) +
 * registry helpers (search/embedding-column.ts) can import the constants
 * without pulling the full AI gateway (which loads every provider SDK).
 *
 * gateway.ts re-exports these so existing import sites keep working.
 *
 * Single source of truth for "what does a fresh brain look like when the
 * user passes zero flags?" Touching these defaults touches every fresh
 * install AND every doctor consistency check.
 */

// Company-default, privacy-preserving retrieval stack. The internally hosted
// Qwen3-VL embedding service returns a fixed native 2048d vector for text,
// images, and mixed inputs. Fresh databases use halfvec(2048), which keeps
// the native width while allowing pgvector HNSW indexing (halfvec supports
// up to 4000 dimensions).
export const DEFAULT_EMBEDDING_MODEL = 'qwen-vllm:./models/Qwen3-VL-Embedding-2B';
export const DEFAULT_EMBEDDING_DIMENSIONS = 2048;
