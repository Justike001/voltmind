---
title: external link integrity review
type: report
report_type: integrity-external-links
date: 2026-07-17
source: default
status: reviewed-with-follow-ups
---

# External-link integrity review — 2026-07-17

## Scope and result

- **Real scan entry:** `voltmind doctor --json` → `integrity` check → `scanIntegrity(engine, { limit: 500 })`.
- **Reproduction command:** `voltmind integrity check --limit 500 --json`.
- **Before:** 73 external-link hits in the first 500 pages (the doctor report also had 2 bare-tweet hits; bare-tweet is out of scope here).
- **After review:** 73 source URL occurrences retained verbatim; 65 were reachable, 8 require follow-up. No source URL was invented, normalized, deleted, or rewritten.
- **Safe repair:** converted the count-only alert into this per-occurrence, source-page/line-traceable report. The 8 non-clean occurrences are also recorded in the adjacent JSONL review log using the existing integrity skip-log fields.

## Review rules

- `verified`: live HEAD/GET returned HTTP 200 and the original URL is complete.
- `redirected`: the original URL returned HTTP 200 after following a redirect; the original source URL is preserved.
- `unverified`: the request timed out; this is not treated as a dead link.
- `incomplete-template`: the URL contains an explicit placeholder (`handle`, `ID`, or `<owner>`); no replacement was inferred.
- `dead-404`: the original URL returned HTTP 404; no replacement was inferred.

## 73 occurrences

| # | Source page | Line | Original URL | Result |
|---:|---|---:|---|---|
| 1 | `changelog` | 997 | https://github.com/garrytan/gbrain/pull/1472 | verified (200) |
| 2 | `changelog` | 998 | https://github.com/garrytan-agents | verified (200) |
| 3 | `changelog` | 1251 | https://github.com/garrytan/gbrain/issues/1422 | verified (200) |
| 4 | `changelog` | 1251 | https://github.com/garrytan/gbrain/issues/1433 | verified (200) |
| 5 | `changelog` | 1251 | https://github.com/garrytan/gbrain/issues/1434 | verified (200) |
| 6 | `changelog` | 1251 | https://github.com/garrytan/gbrain/issues/1436 | verified (200) |
| 7 | `changelog` | 1251 | https://github.com/garrytan/gbrain/issues/1309 | verified (200) |
| 8 | `changelog` | 1251 | https://github.com/garrytan/gbrain/issues/1437 | verified (200) |
| 9 | `changelog` | 1251 | https://github.com/garrytan/gbrain/issues/1435 | verified (200) |
| 10 | `changelog` | 1251 | https://github.com/garrytan/gbrain/issues/1432 | verified (200) |
| 11 | `changelog` | 1251 | https://github.com/garrytan/gbrain/issues/1438 | verified (200) |
| 12 | `changelog` | 1874 | https://github.com/garrytan/gbrain/issues/1247 | verified (200) |
| 13 | `changelog` | 1874 | https://github.com/garrytan/gbrain/issues/1269 | verified (200) |
| 14 | `changelog` | 1874 | https://github.com/garrytan/gbrain/issues/1290 | verified (200) |
| 15 | `changelog` | 1874 | https://github.com/garrytan/gbrain/issues/1340 | verified (200) |
| 16 | `changelog` | 1874 | https://github.com/garrytan/gbrain/issues/1342 | verified (200) |
| 17 | `changelog` | 1898 | https://github.com/garrytan/gbrain/issues/1342 | verified (200) |
| 18 | `changelog` | 1903 | https://github.com/garrytan/gbrain/pull/1259 | verified (200) |
| 19 | `changelog` | 1903 | https://github.com/garrytan/gbrain/pull/1337 | verified (200) |
| 20 | `changelog` | 1905 | https://github.com/garrytan/gstack | verified (200) |
| 21 | `changelog` | 1957 | https://github.com/garrytan/gbrain/pull/1259 | verified (200) |
| 22 | `changelog` | 1957 | https://github.com/garrytan/gbrain/pull/1337 | verified (200) |
| 23 | `changelog` | 2684 | https://github.com/garrytan/gbrain/issues/1173 | verified (200) |
| 24 | `changelog` | 2858 | https://github.com/garrytan/gbrain/pull/1321 | verified (200) |
| 25 | `changelog` | 5040 | https://github.com/garrytan/gbrain/pull/1210 | verified (200) |
| 26 | `changelog` | 6078 | https://dashboard.zeroentropy.dev | redirected (200) |
| 27 | `changelog` | 6157 | https://zeroentropy.dev | redirected (200) |
| 28 | `changelog` | 6292 | https://github.com/garrytan/gbrain-evals | verified (200) |
| 29 | `changelog` | 6297 | https://github.com/garrytan/gbrain-evals/blob/main/docs/benchmarks/2026-05-18-brainbench-cat14-cat15-calibration.md | verified (200) |
| 30 | `changelog` | 6597 | https://github.com/jayzalowitz/skytwin | verified (200) |
| 31 | `changelog` | 7272 | https://github.com/garrytan/gbrain/pull/964 | verified (200) |
| 32 | `docs/ai-providers/llama-server-reranker` | 3 | https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md | verified (200) |
| 33 | `docs/ai-providers/llama-server-reranker` | 77 | https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md | verified (200) |
| 34 | `docs/ai-providers/zeroentropy` | 3 | https://zeroentropy.dev | redirected (200) |
| 35 | `docs/ai-providers/zeroentropy` | 20 | https://dashboard.zeroentropy.dev | redirected (200) |
| 36 | `docs/architecture/retrieval` | 24 | https://github.com/garrytan/gbrain-evals | verified (200) |
| 37 | `docs/architecture/topologies` | 285 | https://voyageai.com/blog | unverified (timeout) |
| 38 | `docs/eval-bench` | 311 | https://github.com/garrytan/gbrain-evals | verified (200) |
| 39 | `docs/eval-bench` | 342 | https://huggingface.co/datasets/xiaowu0162/longmemeval | verified (200) |
| 40 | `docs/eval-capture` | 8 | https://github.com/garrytan/gbrain-evals | verified (200) |
| 41 | `docs/eval-takes-quality` | 13 | https://github.com/garrytan/gbrain-evals | verified (200) |
| 42 | `docs/eval/search_mode_methodology` | 20 | https://huggingface.co/datasets/xiaowu0162/longmemeval | verified (200) |
| 43 | `docs/eval/search_mode_methodology` | 22 | https://github.com/garrytan/gbrain-evals | verified (200) |
| 44 | `docs/guides/scaling-skills` | 307 | https://github.com/garrytan/gbrain | verified (200) |
| 45 | `docs/guides/source-attribution` | 61 | https://x.com/handle/status/ID | incomplete-template (HTTP 403) |
| 46 | `docs/install` | 7 | https://github.com/garrytan/openclaw | verified (200) |
| 47 | `docs/install` | 7 | https://github.com/garrytan/hermes | dead-404 |
| 48 | `docs/install` | 31 | https://github.com/garrytan/gbrain/issues/218 | verified (200) |
| 49 | `docs/integrations/credential-gateway` | 13 | https://clawvisor.com | redirected (200) |
| 50 | `docs/integrations/embedding-providers` | 65 | https://voyageai.com/blog | unverified (timeout) |
| 51 | `docs/integrations/embedding-providers` | 154 | https://docs.litellm.ai/docs/proxy/quick_start | verified (200) |
| 52 | `docs/integrations/embedding-providers` | 173 | https://github.com/garrytan/gbrain/issues | verified (200) |
| 53 | `docs/integrations/meeting-webhooks` | 5 | https://circleback.ai | redirected (200) |
| 54 | `docs/integrations/meeting-webhooks` | 31 | https://openphone.com | redirected (200) |
| 55 | `docs/mcp/alternatives` | 10 | https://ngrok.com | redirected (200) |
| 56 | `docs/mcp/alternatives` | 30 | https://tailscale.com/kb/1223/tailscale-funnel | redirected (200) |
| 57 | `docs/tutorials/company-brain` | 499 | https://github.com/garrytan/gbrain-evals/blob/main/docs/benchmarks/2026-05-23-v0.40.6.0-snapshot.md | verified (200) |
| 58 | `docs/tutorials/company-brain` | 555 | https://www.ycombinator.com/rfs#company-brain | verified (200) |
| 59 | `docs/tutorials/company-brain` | 557 | https://github.com/garrytan/gbrain/issues | verified (200) |
| 60 | `docs/tutorials/personal-brain` | 77 | https://t.me/BotFather | verified (200) |
| 61 | `docs/tutorials/personal-brain` | 89 | https://alphaclaw.com | redirected (200) |
| 62 | `docs/tutorials/personal-brain` | 142 | https://supabase.com | redirected (200) |
| 63 | `docs/tutorials/personal-brain` | 257 | https://github.com/garrytan/gbrain/issues | verified (200) |
| 64 | `docs/tutorials/readme` | 14 | https://github.com/garrytan/openclaw | verified (200) |
| 65 | `docs/tutorials/readme` | 14 | https://github.com/garrytan/hermes | dead-404 |
| 66 | `docs/tutorials/readme` | 28 | https://diataxis.fr/ | verified (200) |
| 67 | `evals/functional-area-resolver/readme` | 166 | https://arxiv.org/abs/2402.04253 | verified (200) |
| 68 | `evals/functional-area-resolver/readme` | 167 | https://arxiv.org/html/2505.03275v1 | verified (200) |
| 69 | `evals/functional-area-resolver/readme` | 168 | https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills | verified (200) |
| 70 | `evals/functional-area-resolver/variants/baseline` | 57 | https://github.com/<owner>/brain/blob/main/path.md | incomplete-template (HTTP 404) |
| 71 | `evals/functional-area-resolver/variants/functional-areas` | 57 | https://github.com/<owner>/brain/blob/main/path.md | incomplete-template (HTTP 404) |
| 72 | `evals/functional-area-resolver/variants/resolver-of-resolvers` | 57 | https://github.com/<owner>/brain/blob/main/path.md | incomplete-template (HTTP 404) |
| 73 | `install_for_agents` | 33 | https://github.com/garrytan/gbrain/issues/218 | verified (200) |

## Follow-up queue

These entries remain unchanged because the source URL needed to repair them is not present in the scanned content:

| Source occurrence(s) | Original URL | Action |
|---|---|---|
| `docs/guides/source-attribution:61` | `https://x.com/handle/status/ID` | Replace only when the actual X status URL is supplied; do not infer it. |
| `docs/install:7`; `docs/tutorials/readme:14` | `https://github.com/garrytan/hermes` | Confirm the intended repository or remove the reference with owner approval; no replacement inferred from a 404. |
| `docs/architecture/topologies:285`; `docs/integrations/embedding-providers:65` | `https://voyageai.com/blog` | Recheck later; both probes timed out, so reachability is unknown. |
| `evals/functional-area-resolver/variants/{baseline,functional-areas,resolver-of-resolvers}:57` | `https://github.com/<owner>/brain/blob/main/path.md` | Fill from the variant's actual repository/source only; no owner/path guessed. |

See `external-link-review-20260717.jsonl` for the traceable integrity-log records for these 8 occurrences.
