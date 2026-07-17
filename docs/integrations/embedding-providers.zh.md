# Embedding providers

VoltMind 内置 14 个 embedding-provider recipes，覆盖 OpenAI、主要托管替代品、三个本地选项，以及一个通用逃生口（LiteLLM proxy）。运行 `voltmind providers list` 查看实时 registry；`voltmind providers explain --json` 会输出给 agents 使用的机器可读矩阵。

本页是面向人的对应说明：每个 provider 的能力、env-var setup、dimensions、cost 和已知约束。

## Quick start

```
voltmind providers list                          # see all providers
voltmind providers env <provider-id>             # see required env vars
voltmind providers test --model openai:text-embedding-3-large   # smoke-test
voltmind init --pglite --model voyage            # use a non-default provider
```

## TL;DR table

| Provider | env vars | default dims | cost ($/1M tokens) | local? | multimodal? |
|---|---|---|---|---|---|
| `openai` | `OPENAI_API_KEY` | 1536 | 0.13 | no | no |
| `voyage` | `VOYAGE_API_KEY` | 1024 | 0.18 | no | yes (`voyage-multimodal-3`) |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` | 768 | 0.025 | no | no |
| `azure-openai` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT` | 1536 | 0.13 | no | no |
| `minimax` | `MINIMAX_API_KEY` | 1536 | 0.07 | no | no |
| `dashscope` | `DASHSCOPE_API_KEY` | 1024 | varies | no | no |
| `zhipu` | `ZHIPUAI_API_KEY` | 1024 | varies | no | no |
| `ollama` | (none — runs locally) | 768 | 0 | yes | no |
| `llama-server` | (none — runs locally) | user-set | 0 | yes | no |
| `litellm` | `LITELLM_API_KEY` (optional) | user-set | varies | yes (proxy) | no |
| `together` | `TOGETHER_API_KEY` | 768 | varies | no | no |
| `anthropic` | (no embedding model — chat only) | — | — | — | — |
| `deepseek` | (no embedding model — chat only) | — | — | — | — |
| `groq` | (no embedding model — chat only) | — | — | — | — |

## Decision tree

- **Cost-sensitive, English-only**: Ollama（免费、本地）或 Voyage（付费、每美元质量最佳）。
- **Quality-first**: Voyage `voyage-4-large`（1024-2048 dims，dense tokens 比 OpenAI tiktoken 多约 3-4×）。
- **Reranking pair**: Voyage（其 reranker `rerank-2.5` 与 Voyage embeddings 配合干净）。
- **Enterprise compliance**: Azure OpenAI（data residency + private endpoints）或通过 llama-server / Ollama 自托管。
- **China region**: DashScope（Alibaba）或 Zhipu（BigModel）。DashScope 的 international endpoint 是 `dashscope-intl.aliyuncs.com`；China endpoint 可覆盖 `provider_base_urls.dashscope`。
- **OSS local, full control**: llama-server（`llama.cpp`）用于任何 GGUF model；Ollama 用于 curated catalog。
- **Anything else**: LiteLLM proxy。把 LiteLLM 放在任何 provider（Bedrock、Vertex、Cohere、Jina、Fireworks 等）前面，并通过 `LITELLM_BASE_URL` 指向 voltmind。

## Per-provider details

### OpenAI

默认。设置 `OPENAI_API_KEY`。Models: `text-embedding-3-large`（3072 max，1536 default）、`text-embedding-3-small`（1536）。通过 `dimensions` field 做 Matryoshka — voltmind 会从 `embedding_dimensions` config 固定它，使现有 1536-dim brains 在 SDK 升级之间保持对齐。

### Voyage AI

Voyage 4 family（2026 年 1 月 release）在质量上属一流水平。设置 `VOYAGE_API_KEY`。Models: `voyage-4-large`、`voyage-4`、`voyage-4-lite`、`voyage-4-nano`、`voyage-3.5`、`voyage-code-3`（code-tuned）、`voyage-finance-2`、`voyage-law-2`、`voyage-multimodal-3`（text + image）。

Voyage 4 family 的所有 variants 共享同一个 embedding space，所以你可以用 `voyage-4-large` 建索引，再用 `voyage-4-lite` 查询，而无需重新索引。Dims: 256、512、1024、2048。**2048 超过 pgvector 的 HNSW cap 2000** — 这些 brains 会回退到 exact vector scans（仍然正确，只是更慢）。

### Google Gemini

设置 `GOOGLE_GENERATIVE_AI_API_KEY`（AI Studio public API key）。Model: `gemini-embedding-001`。默认 768 dims；Matryoshka up to 3072。便宜。

对于 GCP service-account / Vertex AI auth（production deployments），见 v0.32.x follow-up — Vertex ADC 在 roadmap 上。

### Azure OpenAI

Azure tenancy 后面的企业 OpenAI。必需 env: `AZURE_OPENAI_API_KEY`、`AZURE_OPENAI_ENDPOINT`（例如 `https://my-resource.openai.azure.com`）、`AZURE_OPENAI_DEPLOYMENT`（Azure portal 中的 deployment name）。可选：`AZURE_OPENAI_API_VERSION`（默认 `2024-10-21`）。

不同于 vanilla OpenAI，Azure 使用 `api-key:` header（不是 `Authorization: Bearer`）以及带 `?api-version=` query param 的模板化 URL — voltmind 通过 recipe 的 resolveAuth + resolveOpenAICompatConfig overrides 处理两者。

Models: `text-embedding-3-large`、`text-embedding-3-small`、`text-embedding-ada-002`（你的 Azure deployment 必须服务所请求的 model）。

### MiniMax (海螺AI)

设置 `MINIMAX_API_KEY`。组织级账号可选 `MINIMAX_GROUP_ID`。Model: `embo-01`（1536 dims）。

MiniMax API 接收一个 `type: 'db' | 'query'` 字段，用于 asymmetric retrieval。v0.32 将所有内容路由为 `type='db'`（symmetric retrieval — indexing 和 queries 使用同一 vector space）。Asymmetric query support 是 v0.32.x follow-up。

### DashScope (Alibaba)

设置 `DASHSCOPE_API_KEY`。默认 international endpoint 是 `dashscope-intl.aliyuncs.com`；China endpoint 可覆盖 `provider_base_urls.dashscope`。Models: `text-embedding-v3`（current；Matryoshka 64-1024 dims）、`text-embedding-v2`。

CJK-dominant content 的 tokenization 比 OpenAI tiktoken 更密；voltmind 声明 `chars_per_token: 2`，让 batch pre-split 留出余量。

### Zhipu AI (BigModel)

设置 `ZHIPUAI_API_KEY`。Models: `embedding-3`（current；Matryoshka 256-2048 dims）、`embedding-2`。v0.32 默认 1024（HNSW-compatible）。2048-dim 选项可用，但会落入 exact-scan branch（见上面的 Voyage 4 Large 注）。

### Ollama (local)

无需 env — Ollama 在本地无认证运行。可选 `OLLAMA_BASE_URL`（默认 `http://localhost:11434/v1`）和 `OLLAMA_API_KEY`（用于启用 auth 的部署）。

Recipe 自带 `nomic-embed-text`（768d，推荐）、`mxbai-embed-large`（1024d）、`all-minilm`（384d）。`voltmind providers test --model ollama:nomic-embed-text` 可 smoke-test 本地安装。

### llama-server (local, llama.cpp)

`llama.cpp` 的 `llama-server --embeddings` endpoint。无需 env。可选 `LLAMA_SERVER_BASE_URL`（默认 `http://localhost:8080/v1`）和 `LLAMA_SERVER_API_KEY`。

User-driven models：用 `--model <gguf-path> --embeddings` 启动 llama-server，然后运行 `voltmind init --embedding-model llama-server:<your-id> --embedding-dimensions <N>`。recipe 会拒绝隐式 shorthand `--model llama-server`，因为没有 canonical first model。

### LiteLLM proxy (universal escape hatch)

在任意 provider — Bedrock、Vertex、Cohere、Jina、Fireworks、OctoAI 等 — 前面运行 [LiteLLM](https://docs.litellm.ai/docs/proxy/quick_start)。proxy 会把一切标准化为 OpenAI-compatible API；voltmind 通过 `LITELLM_BASE_URL` 指向 proxy 并代理调用。

这是 “my provider isn't in the list above” 的兜底方式。设置 LiteLLM 后运行 `voltmind init --embedding-model litellm:<your-model-id> --embedding-dimensions <N>`。

## Choosing dimensions

三个数字重要：
1. **Provider's native dims**：每个 model 有一个“真实”输出维度（例如 OpenAI `text-embedding-3-large` 原生 3072）。
2. **Matryoshka reductions**：多数现代 providers 允许通过 `dimensions` field 请求更小向量。
3. **HNSW cap**：pgvector 的 HNSW index 最多支持 2000 dims。超过的 brains 会回退到 exact vector scans（更慢但正确；voltmind 通过 `src/core/vector-index.ts` 中的 `chunkEmbeddingIndexSql` 自动处理 SQL）。

对大多数用户：**保持 1024 或 1536**。在 noise floor 以下，更大并不更好；更小可以节省 disk + RAM，并且在 Matryoshka providers 上只带来边际 recall 损失。

## My provider isn't listed

三个选项：

1. **Use LiteLLM proxy**（见上）— 通用逃生口。适用于 100+ providers。
2. 在 [github.com/garrytan/voltmind/issues](https://github.com/garrytan/voltmind/issues) 开 feature request，附 provider 的 API docs URL 和 setup snippet。Recipes 大约是 30-40 行 TypeScript。
3. **Submit a recipe**：clone，复制 `src/core/ai/recipes/voyage.ts` 作为 gold-standard openai-compat template，在 `src/core/ai/recipes/index.ts` 注册，在 `test/ai/recipe-<name>.test.ts` 下添加 per-recipe smoke test。recipe contract test（`test/ai/recipes-contract.test.ts`）和 IRON RULE regression test 会固定 structural invariants。

## Switching providers on an existing brain

Embedding dimensions 在 `voltmind init` 时写入 schema。初始化后改 provider，通常需要重新 embed：

1. 更新 config：`voltmind config set embedding_model <provider>:<model>` 和 `embedding_dimensions <N>`。
2. 如果 dims 改了，重建 schema index：`voltmind doctor` 会检测 mismatch，并打印精确的 `ALTER TABLE` recipe。
3. 重新 embed：`voltmind embed --all`（或 `--stale` 做 incremental）。

`voltmind doctor` 8c "alternative_providers" 会暴露 env 已设置但尚未配置的 providers — 当你配置了 OpenAI，同时也导出了例如 `VOYAGE_API_KEY`，并想知道无需额外 setup 就能切换时很有用。
