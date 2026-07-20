import type { Recipe } from '../types.ts';

/** Company-internal vLLM deployment of Qwen3-VL-Reranker-2B. */
export const qwenVllmReranker: Recipe = {
  id: 'qwen-vllm-reranker',
  name: 'Company internal Qwen3-VL Reranker (vLLM)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://192.168.70.249:8003/v1',
  auth_env: {
    required: [],
    optional: ['QWEN_VLLM_RERANKER_BASE_URL', 'QWEN_VLLM_RERANKER_API_KEY'],
  },
  touchpoints: {
    reranker: {
      models: ['Qwen3-VL-Reranker-2B'],
      default_model: 'Qwen3-VL-Reranker-2B',
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-07-17',
      max_payload_bytes: 5_000_000,
      path: '/rerank',
      default_timeout_ms: 15_000,
    },
  },
  setup_hint:
    'Set provider_base_urls.qwen-vllm-reranker to your internal vLLM `/v1` base URL, ' +
    'then enable search.reranker with qwen-vllm-reranker:Qwen3-VL-Reranker-2B.',
};
