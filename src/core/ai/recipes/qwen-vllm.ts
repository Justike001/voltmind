import type { Recipe } from '../types.ts';
import { probeLlamaServer } from '../probes.ts';

/**
 * Company-internal vLLM deployment of Qwen3-VL-Embedding-2B.
 *
 * Text uses vLLM's OpenAI-compatible `/v1/embeddings` endpoint. Images and
 * mixed inputs use the Cohere-compatible `/v2/embed` endpoint, whose request
 * shape is different from OpenAI's content-array embedding wire format.
 * The model is native 2048d and does not support output-dimension reduction.
 */
export const qwenVllm: Recipe = {
  id: 'qwen-vllm',
  name: 'Company internal Qwen3-VL Embedding (vLLM)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://192.168.70.249:8000/v1',
  auth_env: {
    required: [],
    optional: ['QWEN_VLLM_BASE_URL', 'QWEN_VLLM_API_KEY'],
  },
  touchpoints: {
    embedding: {
      models: ['./models/Qwen3-VL-Embedding-2B'],
      default_dims: 2048,
      supports_multimodal: true,
      multimodal_models: ['./models/Qwen3-VL-Embedding-2B'],
      multimodal_protocol: 'vllm-cohere-v2',
      multimodal_path: '/v2/embed',
      // The served model reports max_model_len=4096. CJK and image payloads
      // are dense, so stay conservative when forming text batches.
      max_batch_tokens: 4096,
      chars_per_token: 1,
      safety_factor: 0.8,
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-07-17',
    },
  },
  async probe(baseURL?: string) {
    const url = baseURL ?? process.env.QWEN_VLLM_BASE_URL ?? 'http://192.168.70.249:8000/v1';
    const result = await probeLlamaServer(url);
    if (!result.reachable) {
      return { ready: false, hint: `Qwen vLLM embedding service is not reachable at ${url}.` };
    }
    if (!result.models_endpoint_valid) {
      return { ready: false, hint: `Qwen vLLM embedding service returned an unexpected /v1/models response at ${url}.` };
    }
    return { ready: true };
  },
  setup_hint:
    'Set provider_base_urls.qwen-vllm to your internal vLLM `/v1` base URL. ' +
    'Use qwen-vllm:./models/Qwen3-VL-Embedding-2B with 2048 dimensions.',
};
