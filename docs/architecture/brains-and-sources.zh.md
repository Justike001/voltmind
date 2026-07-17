# Brains and Sources — 心智模型

VoltMind 有两条相互正交的轴来组织知识。用户和 agents 都需要理解这两条轴，
否则查询会静默地路由到错误位置。

**TL;DR:**
- **brain** 是一个数据库。你可以有很多个。
- **source** 是 brain *内部* 一个有名字的内容 repo。一个 brain 可以包含多个 source。
- `--brain <id>` 选择 WHICH DATABASE。
- `--source <id>` 选择该数据库 WITHIN 的 WHICH REPO。
- 它们彼此独立。你可以指定任意组合。

---

## The two axes

### Brains（DB 轴）

一个 **brain** 就是一个数据库 — PGLite 文件、自托管 Postgres，或 Supabase。
每个 brain 都有：
- 自己的 `pages` table、`chunks` table、`embeddings` 等。
- 如果通过 HTTP MCP 服务（v0.19+，PR 2），有自己的 OAuth surface。
- 自己独立的 lifecycle、backup、access control。

Brains 通过以下方式枚举：
- **host** — 你的默认 brain，配置在 `~/.voltmind/config.json`。
- **mounts** — 通过 `voltmind mounts add <id>`（v0.19+）注册在
  `~/.voltmind/mounts.json` 中的额外 brains。

路由：`--brain <id>`、`VOLTMIND_BRAIN_ID`、`.voltmind-mount` dotfile，
或对已注册 mount paths 做 longest-path match。回退到 `host`。

### Sources（repo 轴，v0.18.0+）

一个 **source** 是一个 brain *内部* 的命名内容 repo。每一行 `pages`
都带有 `source_id`。Slugs 是按 source 唯一，而不是全局唯一。

示例：在同一个 brain 中，slug `topics/ai` 可以同时存在于 `source=wiki`
和 `source=gstack` 下 — 它们是不同页面。

路由：`--source <id>`、`VOLTMIND_SOURCE`、`.voltmind-source` dotfile，
或 `sources` table 中已注册 `local_path` 的匹配。

### When does each axis move?

| You want to | Adjust |
|---|---|
| 在同一 brain 内切换到不同 repo（wiki → gstack notes） | `--source` |
| 查询一个不是你的、由团队发布的 brain | `--brain` |
| 隔离某个 topic，确保它永远不会泄漏到个人搜索 | `--source` with `federated=false` |
| 与队友共享一个 brain | `--brain`（mount the team brain） |
| 给个人 brain 增加一个新 repo | `--source` via `voltmind sources add` |
| 增加一个 team brain | `--brain` via `voltmind mounts add` |

**经验法则：** 如果数据所有者变了，那就是 brain boundary。如果数据所有者不变，
只是 topic/repo 变了，那就是 source boundary。

---

## Topology: a single-person developer

最简单的情况。一个 brain，一个 source。

```
┌─────────────────────────────────────────┐
│  host brain (~/.voltmind)                 │
│  ├── source: default (federated=true)   │
│  │   └── all pages                      │
└─────────────────────────────────────────┘
```

`voltmind query "retry budgets"` 会找到全部内容。不需要 `--brain`，也不需要
`--source`。

---

## Topology: a personal brain with multiple repos

你维护多个 codebases 或写作流。每个都是同一个 brain 内自己的 source。
Cross-source search 默认开启，所以关于 "caching" 的查询会返回每个 repo 的 hits。

```
┌──────────────────────────────────────────────┐
│  host brain (~/.voltmind)                      │
│  ├── source: wiki      (federated=true)      │
│  │   └── personal notes, people, companies   │
│  ├── source: gstack    (federated=true)      │
│  │   └── gstack plans, learnings             │
│  ├── source: openclaw  (federated=true)      │
│  │   └── openclaw docs, memos                │
│  └── source: essays    (federated=false)     │
│      └── draft essays, isolated on purpose   │
└──────────────────────────────────────────────┘
```

在 `~/openclaw/` 内，`.voltmind-source` dotfile 会把每个命令固定到
`source=openclaw`。在 `~/gstack/` 内，dotfile 会固定到 `source=gstack`。
所有内容仍然指向同一个 DB。

适合这种 topology 的情况：
- 所有内容都归你所有。
- 你希望跨 repo 搜索自然可用。
- 你不需要把其中任何内容分享给其他人。

---

## Topology: personal brain + one team brain

你在一个发布共享 brain 的团队里。你的个人 brain 保持原样；你把 team brain
mount 到旁边。

```
┌──────────────────────────────────────────────┐
│  host brain (~/.voltmind)  — YOUR personal DB  │
│  ├── source: wiki                            │
│  ├── source: gstack                          │
│  └── ...                                     │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│  mount: media-team                           │
│  path:   ~/team-brains/media                 │
│  engine: postgres (team's Supabase)          │
│  └── sources: wiki, raw, enriched            │
└──────────────────────────────────────────────┘
```

`voltmind query "X"`（无 flags）→ 针对 host（你的 personal brain）运行。
`voltmind query "X" --brain media-team` → 针对团队的 DB 运行。
在 `~/team-brains/media/` 内，`.voltmind-mount` dotfile 会自动把 brain 固定到
`media-team`。

适合这种 topology 的情况：
- 你在团队中，并且有人发布了团队订阅的 brain。
- 你需要在工作和个人之间做数据隔离。
- 不同团队/组织拥有不同 brains。

---

## Topology: a CEO-class user with multiple team memberships

你足够资深，横跨多个团队。你维护自己的个人 brain（其中有 N 个 sources），
同时 mount 多个工作团队的 brains。每个 team brain 本身也是 v0.18.0 意义上的
multi-source brain — 内部如何组织由 team owner 决定。

```
┌──────────────────────────────────────────────┐
│  host brain — YOUR personal DB               │
│  ├── source: wiki                            │
│  ├── source: essays                          │
│  ├── source: gstack                          │
│  └── source: openclaw                        │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│  mount: media-team (your media team's brain) │
│  └── sources: wiki, pipeline, enriched       │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│  mount: policy-team (your policy team's)     │
│  └── sources: wiki, research, letters        │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│  mount: portfolio (another team's)           │
│  └── sources: companies, deals, diligence    │
└──────────────────────────────────────────────┘
```

在每个团队 checkout 内，`.voltmind-mount` dotfile 会固定 brain。在特定子目录中，
`.voltmind-source` dotfile 会固定 source。因此 `cd
~/team-brains/policy/research && voltmind query "X"` 会零 flags 地指向
`brain=policy-team, source=research`。

适合这种 topology 的情况：
- 你横跨多个团队。
- 每个团队拥有自己的 brain 和自己的访问策略。
- 你需要 latent-space federation（agent 决定何时跨 brains 查询），而不是 SQL federation。

在 v0.19 中，cross-brain queries **不是 deterministic**。agent 会看到 brain list，
并按需重新查询。这正是该功能的意义 — 它让 debugging 保持清晰，也让 access control 干净。

---

## Resolution precedence（记住这一页）

```
WHICH BRAIN (DB)?                    WHICH SOURCE (repo in DB)?
 1. --brain <id>                      1. --source <id>
 2. VOLTMIND_BRAIN_ID env               2. VOLTMIND_SOURCE env
 3. .voltmind-mount dotfile             3. .voltmind-source dotfile
 4. longest-prefix mount path match   4. longest-prefix source path match
 5. (reserved: brains.default v2)     5. sources.default config
 6. fallback: 'host'                  6. fallback: 'default'
```

这两条轴刻意遵循同样的 layered pattern。知道一个，就知道另一个。

---

## For agents reading this

- 用户提问时的默认假设：从当前 brain 开始（按上面的 precedence 解析）。
  不要无故跳到其他 brains。
- 如果用户问的问题跨越某个团队可能拥有的 topic area（例如 “Team X 上周决定了什么？”），
  正确做法是 *显式查询该团队的 brain*，而不是在 host 中搜索 “team x”。
- Cross-brain federation 是 YOUR JOB，不是 DB 的工作。你有 brain list
  （`voltmind mounts list`）。你决定何时 fan out。你综合 findings。
  你引用 `brain:source:slug`。
- 写页面时，尊重 brain boundary。关于某团队工作的事实属于团队的 brain，
  而不是用户的 personal brain。跨 brain 写入前先询问。
- 完整决策表见 `skills/conventions/brain-routing.md`。

## For users reading this

- **Default path:** 设置你的 personal brain（`voltmind init`），为每个关心的 repo
  增加一个 source（`voltmind sources add gstack --path ~/gstack`）。
  你几乎永远不需要 `--brain`。
- **When a team publishes a brain:** `voltmind mounts add <team-id> --path
  <clone> --db-url <url>`，该 checkout 中的 `.voltmind-mount` dotfile
  会自动把查询路由到那里。
- **When you are the CEO-class user with multiple team memberships:** mount
  每个 team brain。信任 resolver — 在团队目录内，dotfile 选择 brain；
  在子目录内，dotfile 选择 source。flags 用于你想要有意跨 boundary 查询的时候。

## Further reading

- v0.18.0 CHANGELOG — 引入 `sources` primitive。
- v0.19.0 CHANGELOG（PR 0+1+2 发布后 TBD）— 引入 `mounts`。
- `docs/mounts/publishing-a-team-brain.md`（PR 2）— 如何成为 brain publisher，
  而不仅仅是 subscriber。
