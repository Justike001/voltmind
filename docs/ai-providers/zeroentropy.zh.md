# 零entropy - zemped-1 + zerank-2

[ZeroEntropy](https://zeroentropy.dev)用于回收管道的两艘专门小型船舶:

- ** **`zembed-1`** - 从 Zerank-2 中提炼的多语言嵌入。
软体马特约什卡薄膜(2560)/1280/640/320/160/80/40), 32K 上下文,
  asymmetric `input_type: query|文件`编码 ' 。 0.025美元/1M等号
(销售)/0.05美元经常。
- ** **`zerank-2`** -SOTA多语种交叉编码器重新排序 。
0.025美元/1M等号 (~ 50% 比 Cother 便宜)/Voyage加号(加号)`zerank-1`和`zerank-1-small`用于满足遗留/开放源码需求。

与OpenAI公司和Voyage公司并列,

## Setup

1. Get an API key at
[dashboard.zeroentropy.dev](https://dashboard.zeroentropy.dev). .
2. Export it:
   ```bash
   export ZEROENTROPY_API_KEY=<your-key>
   ```

## 嵌入式开关-组合-1

** 进口:**`voltmind config set embedding_model …`是NOT一个实时网关开关。`embedding_model`和`embedding_dimensions`且必须在引擎连接之间保持稳定, 因此它们只能从 ** file 平面** 中解析 。`~/.voltmind/config.json`和** env 平面** (`VOLTMIND_EMBEDDING_MODEL`/ 调 调 调`VOLTMIND_EMBEDDING_DIMENSIONS`对于这两把钥匙(与今天的Voyage设置相同的姿势),DB平面被故意忽略。

### 备选办法A——文件平面(建议用于稳定安装)

编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑编辑`~/.voltmind/config.json`:

```json
{
  "embedding_model": "zeroentropyai:zembed-1",
  "embedding_dimensions": 2560
}
```

有效亮度 :`2560`(违约),`1280`,`640`,`320`,`160`,`80`,`40`Matryoshka 风格 — 单质存储的更小交易质量。 选择适合您纵队宽度的最大交易 。

### 备选办法B-螺旋平面(CI/多克)

```bash
export VOLTMIND_EMBEDDING_MODEL=zeroentropyai:zembed-1
export VOLTMIND_EMBEDDING_DIMENSIONS=2560
```

### Re-embed

Switching embedding models invalidates the vector index. Re-embed:

```bash
voltmind embed --stale --limit 50    # smoke a small batch
voltmind embed --stale               # full re-embed
```

### Verify

```bash
voltmind models doctor --json | jq '.probes[] | select(.touchpoint=="embedding_config")'
```

预期:`status: "ok"`。无效的暗暗(例如)`1024`,`1536`,`3072`表面为`status: "config"`有糊糊的已准备就绪
'2560年之一的脑电图配置集嵌入_dimension < one of 2560|1280|640|320|160|80|40个补丁提示

## 重置器开关 - Zerank-2

The reranker is the bigger story: voltmind had no cross-encoder reranker stage before v0.35.0.0. It slots between RRF dedup and token-budget enforcement in hybrid search.

### Default-on with `tokenmax` mode

`tokenmax`模式模式现在默认`search.reranker.enabled = true`与`zerank-2`。如果您已经使用`tokenmax` AND拥有`ZEROENTROPY_API_KEY`设置, 重新锁定自动火灾 。 没有密钥, 每一次重命名调用失败( 审计- 浏览) 和搜索返回RRF与以前相同的UX,只是通过`voltmind doctor`. .

### Opt-in on `conservative` or `balanced` mode

```bash
voltmind config set search.reranker.enabled true
```

超常位于模式- 组合默认值之上; 选择退出是一个翻转 。

### Cost anchor

30名候选人x~400象征性/chunk× 0.025美元/1M= $0.0003 美元/query** 与《公约》有关的四舍五入错误`tokenmax + Opus`配对的金额~700美元/mo单用户数量CLAUDEmd 成本矩阵。

### Verify

```bash
voltmind models doctor --json | jq '.probes[] | select(.touchpoint=="reranker_config")'
```

Two probes run for reranker:
- `reranker_config`(零网络)——验证模型解决方案
通过食谱登记 并在触摸点的许可名单中
- 可达性探测器发送最小的 query : “ 可能 ” , 文件 :
["可能"] 重新排序 以校验经 +URL. .

## Knobs reference

| Config key | Default | Notes |
|---|---|---|
| `search.reranker.enabled` | `true`以物配主者发誓,`false`其他人的 | One-flip opt-in/out |
| `search.reranker.model` | `zeroentropyai:zerank-2` | 尝试`zerank-1`(老SOTA) 或`zerank-1-small`(帕切-2.0开放) |
| `search.reranker.top_n_in` | `30` | 重新排序的候选人(上限)API支出(支出) |
| `search.reranker.top_n_out` | `null`(无计时) | 将重新排序的产出排成这么多;`null`保留整个长度 |
| `search.reranker.timeout_ms` | `5000` | HTTP超时超时; 长的摊间会降解比UX更差RRF后退后 |

## Failure observability

重排序器因构造而开启不打开:每个错误类别( auth、 费率限制、 网络、 超时、 有效载荷太大、 未知) 返回原始RRF失败日志`~/.voltmind/audit/rerank-failures-YYYY-Www.jsonl`( ( ) (ISO-(每周轮换))

`voltmind doctor` reads the audit and surfaces:
- ** 故障**——任何一个单一的警告(配置时间问题医生的)
) 自己探测器应该已经捕捉到)
- ** 超大有效载荷**——任何单一警告(超大有效载荷信号)
- ** 过渡(网络)/timeout/rate_limit** 7天后5点发出警告

查询文本为SHA-256在审计中仓促记录;从未原始记录。

## Asymmetric input_type

ZE zembed-1 (和Voyage v3+) 使用非对称查询/document用于更好地检索的编码。`embedQuery(text)`附加线线`input_type: 'query'`; 标准; 标准`embed(texts)`默认默认值`'document'`混合搜索的两个查询侧嵌入网站的使用`embedQuery()`自动; 自动使用所有入口路径`embed()`. .

对称提供商(OpenAI 文本组合-3,固定底码Voyage模型)忽略了字段——没有行为变化。

## Cache key versioning

0.35.0.0 撞撞`KNOBS_HASH_VERSION`1 2 到折叠重置器配置为`query_cache.knobs_hash`在滚动部署期间:

- 期待临时缓存缓存超速缓存( 默认时~ 1小时)
`cache.ttl_seconds = 3600s`)
- 热查询可简单将其缓存点列数数(每列一)翻一番(每列一)
版本)

两者自然都清楚;不需要操作者行动。

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `embedding_config` probe says invalid dim | 默认为 1536( OpenAI 默认) | Set `embedding_dimensions` to one of 2560/1280/640/320/160/80/40 |
| `reranker_config` probe says model not in allowlist | Typo in `search.reranker.model` | Use one of `zerank-2` / `zerank-1` / `zerank-1-small` |
| `reranker_health` doctor warns about auth | `ZEROENTROPY_API_KEY` not set or invalid | (a) 再出口(vv var);`voltmind models doctor`核查核查 |
| `reranker_health` doctor warns about transient failures | Upstream flake or rate limit | 重新排序失败RRF; 如果持续,检查 ZE 状态页面 |
| Cache hit rate dipped after upgrade | Expected during rolling deploy | 内部清空`cache.ttl_seconds`(违约3600秒) |
