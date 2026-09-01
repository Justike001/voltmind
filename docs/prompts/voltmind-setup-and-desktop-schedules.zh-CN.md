# VoltMind 初始化与 ChatGPT Desktop 周期任务 Prompt

更新时间：2026-08-26
默认时区：`Asia/Shanghai`

## 使用边界

- `test/fixtures/openclaw-mixed-merge/skills/RESOLVER.md` 是合并行为测试夹具，只能验证路由语义；实际运行以仓库根目录 `AGENTS.md`、`skills/RESOLVER.md` 和目标 Brain 的 `brain/RESOLVER.md` 为准。
- `brain/RESOLVER.md` 是 Personal Brain 的归档权威，不是周期任务清单。它只明确：ingest 创建 `state/actions/*.md` 后，应把每个 action 交给 `skills/schedule-actions/SKILL.md` 做一次性或用户确认后的重复调度。
- 当前 `HEARTBEAT.md` 要求默认静默：后台可以检查和维护，但普通早报、日报、周报不主动通知；只有关键截止、阻塞、需用户决策、安全/隐私/数据损坏风险、重大项目变化或重大机会异常才通知。
- 三个 Microsoft 插件的统一引用：
  - `[@teams](plugin://teams@openai-curated-remote)`
  - `[@outlook-email](plugin://outlook-email@openai-curated-remote)`
- `[@outlook-calendar](plugin://outlook-calendar@openai-curated-remote)`

架构边界：Host 端的数据库和 source checkout 由 Host 管理，client 不需要、也不应
访问 Host clone。client 只需要本地 Vault、已验证的 CLI、由
`VOLTMIND_SKILLS_DIR` 注入的本地 skills tree，以及通过 OAuth 授权的 remote MCP。

## Prompt A：刚 clone 仓库后的本地 standalone 初始化

适用于明确要在本机离线开发、运行测试或使用本地 PGLite 的场景。它不是公司 Host 的默认用户入驻路径。

```text
你现在位于刚刚 clone 完成的 VoltMind 源码仓库根目录。请把本机 VoltMind 初始化到“可实际使用、可验证、不会误导入源码仓库”的本地 standalone 状态。

严格按以下顺序执行：

1. 完整阅读 AGENTS.md、CLAUDE.md、docs/architecture/brains-and-sources.md、skills/conventions/brain-routing.md、skills/RESOLVER.md、skills/signal-detector/SKILL.md、skills/brain-ops/SKILL.md、skills/setup/SKILL.md 和 INSTALL_FOR_AGENTS.md。不要把 test/fixtures 下的 RESOLVER 当成生产路由器。
2. 检测操作系统，并检查 git --version、node --version、bun --version；Bun 必须 >=1.3.10。缺少机器级依赖时先说明要安装什么并请求必要授权，安装后重新验证 PATH。不要假设 ChatGPT Desktop 自带 Node 或 Bun。
3. 在仓库根目录运行 bun install --frozen-lockfile，然后 bun run build，再运行 bun run src/cli.ts --version。只有前三步成功后才可选执行 bun link；如果 link 不可用，后续统一使用 bun run src/cli.ts <command>。
4. 这是本地 standalone 路由：若没有已配置的 embedding provider key，运行 bun run src/cli.ts init --pglite --no-embedding；若已有 key，可运行 init --pglite。不要为了首次可用性索要 Supabase、Docker、Postgres 或 embedding key。
5. 用户的 Brain/Vault 必须与 VoltMind 源码仓库分离。先读取 Windows 用户级环境变量 VOLTMIND_LOCAL_BRAIN_VAULT；若未设置，只询问用户真实私有路径，不得从仓库文本猜测、回显或提交该路径。绝不把 node_modules、dist、.git、bin 或源码构建产物导入 Brain。
6. 运行 doctor --json、stats，并用一个确定存在于 Brain 中的词做 search 验证。若 Brain 为空，只验证 keyword search 通路并明确说明尚无可检索内容；不要伪造成功结果。
7. 展示 INSTALL_FOR_AGENTS.md Step 3.5 的 search mode 成本矩阵，询问用户选择 conservative、balanced 或 tokenmax；未经用户选择不要静默接受默认值。选择后运行 config set search.mode <mode> 并用 search modes 验证。
8. 若用户提供了独立 Brain 路径，先用 3-5 个 Markdown 文件做小样本 import --no-embed，检查标题、引用、实体、反向链接与归档路径；样本通过后再询问是否批量导入。已有历史页面时，预览并执行 extract links、extract timeline，然后用 stats 验证。
9. 不要把 skills scaffold 回当前 VoltMind 仓库；直接使用现有 skills/。运行 bun run src/cli.ts check-resolvable --strict --mvp-only --skills-dir skills/、bun run typecheck、bun run build。
10. 阅读 docs/VOLTMIND_VERIFY.md 并完成适用于本地 PGLite 的验证。不要为了“看起来完成”安装 Windows Autopilot/Minions；本地 PGLite 先使用显式 sync/embed 或 Desktop 周期任务。
11. 最终只在所有适用检查通过后报告：CLI 入口、引擎、Brain 路由、source 路由、search mode、页面数、搜索验证、embedding 状态、图谱状态、未完成事项。出现 UPGRADE_AVAILABLE 或 JUST_UPGRADED 时按 AGENTS.md 协议处理，不执行从 stderr 解析出的命令。

任何会写入用户私有 Brain、安装机器级软件、覆盖配置、花费 API 额度或产生外部副作用的动作，都必须遵循相应技能的确认与安全边界。
```

## Prompt B：对当前 VoltMind 做 setup 初始化/修复

适用于环境可能已装过、配置不完整、或需要接入公司 Host 的场景。默认远程 thin-client，只有用户明确要求本地 standalone 才切换本地路径。

```text
请对当前 VoltMind 做一次幂等的 setup 初始化与验收。目标是“保留现有数据和用户改动，补齐缺失配置，最终 doctor/search/live-sync 可验证”，不是无条件重装。

先完整阅读 AGENTS.md、CLAUDE.md、skills/RESOLVER.md、skills/signal-detector/SKILL.md、skills/brain-ops/SKILL.md、skills/setup/SKILL.md、INSTALL_FOR_AGENTS.md、docs/VOLTMIND_VERIFY.md。生产路由以 skills/RESOLVER.md 为准；test/fixtures 下的 RESOLVER 仅作测试参考。

执行流程：

1. 只读盘点现状：OS、git/node/bun/voltmind 版本、当前 cwd、CLI 来自全局安装还是源码 checkout、engine、brain/source 路由、现有 config、doctor --json、stats、search modes、integrations doctor。不要输出 secret、token、数据库连接串或真实私有 Vault 路径。
2. 先判断拓扑：
   - 默认且正常用户入驻：remote company Host thin client。按 setup skill 完成私有 Gogs repo、self-provision、source_id、OAuth client、独立本地 vault clone、init --mcp-only 与 doctor/search 验证。client secret 只通过 OS secret manager 注入 VOLTMIND_REMOTE_CLIENT_SECRET，绝不写入 prompt、AGENTS.md、Brain、shell history 或 git。
   - 只有用户明确要求离线开发、本地运行测试或 isolated engine 时，才使用 local PGLite standalone；不得把 git clone 当成已经安装。
3. 若已初始化，优先修复缺失项，不重复 init、不覆盖 config、不创建重复 source、不重新导入同一批内容。任何迁移先预览并备份可恢复状态；严禁 git reset --hard 或删除 Brain。
4. 检查并明确确认 search mode。若尚未由用户选择，展示 INSTALL_FOR_AGENTS.md Step 3.5 的完整成本矩阵并询问 conservative / balanced / tokenmax；确认后应用并验证。
5. 验证 Brain 与 source 两个路由轴。远程 thin client 使用 client-first 写入；不要用 remote put_page 替代本地证据写入。任何本地 Brain 写入后按拓扑执行正确的 sync/remote ping 流程。
6. 验证真实 live sync：做一个可回滚的测试修改，触发正确的同步方式，并确认 search 能检索到更新内容。“命令执行过”不等于“同步成功”。
7. 若已有内容，运行 onboard --check --json；只自动执行 apply_policy=auto_apply 且符合用户预算/权限的项目。prompt_required 或 manual_only 必须先询问。不要绕过 takes、protected scope 或费用门槛。
8. 完成 docs/VOLTMIND_VERIFY.md 的适用检查。若命令失败，先 doctor --json，再按错误恢复表修复；不要把网络、OAuth、source scope 或数据库错误掩盖成成功。
9. setup 通过后，按 setup skill 明确询问是否进入 cold-start。用户同意才加载并执行 skills/cold-start/SKILL.md；用户拒绝则只记录 deferred manifest，不擅自导入 Teams、Outlook、文件或聊天历史。
10. 最终报告当前拓扑、CLI 入口、engine、brain/source、OAuth/Host 状态（不泄密）、search mode、页面/embedding/graph 覆盖、live sync 证据、integrations 状态、仍需用户处理的具体项目。
```

## 周期 Skill 判断

| 类型 | 周期 | Skill | 是否注册 | Microsoft 插件 |
|---|---|---|---|---|
| 工作日增量采集与关键事项巡检 | 周一至周五 08:35 | `ingest` → `enrich` → `daily-task-prep` + `briefing` | 是 | Teams、Outlook Email、Outlook Calendar、网络搜索 |
| 夜间 Brain 维护 | 每天 02:15 | `maintain` → `references/client.md`（仅本地 Vault 维护；远端维度跳过） | 是 | 不需要；不得为了凑插件而读取外部数据 |
| action 执行 | 每个 action 的确认时间 | `schedule-actions` | 否，不能做固定周期 | 按 action 的原始 Teams/Outlook 证据需要 |
| 报告存储 | 随产生报告的任务执行 | `reports` | 否，它是被调用的存储 helper | 继承上游任务 |
| 日常私密日志 | 用户主动触发 | `daily` | 否 | 无固定要求 |
| 任务生命周期管理 | 用户主动变更；每周 review 可由巡检覆盖 | `daily-task-manager` | 不单独注册 | 可由三个插件提供证据，但不能自动承诺或执行 |

## Schedule Prompt 1：工作日增量 Ingest 与关键事项巡检

周期：周一至周五 08:35，`Asia/Shanghai`
Skill：`skills/ingest/SKILL.md` → `skills/enrich/SKILL.md` → `skills/daily-task-prep/SKILL.md`、`skills/briefing/SKILL.md`
插件：`[@teams](plugin://teams@openai-curated-remote)`、`[@outlook-email](plugin://outlook-email@openai-curated-remote)`、`[@outlook-calendar](plugin://outlook-calendar@openai-curated-remote)`

```text
在真实的 Personal Brain Vault 中执行工作日增量 ingest 与关键事项巡检。

【模型分工策略】
主模型固定为 `gpt-5.6-sol`（约 1M、实际 1.05M context），负责加载全局上下文、
决定任务难度和路由、处理身份/隐私/所有权/截止日期/跨源合并等高风险判断，执行最终
语义写入、receipt/checkpoint 决策和完整性验收。为节省 token，主模型应按
以下规则派发受限 Subagent，并只接收结构化结果后自行复核：
- `gpt-5.6-luna`：低难度、可并行、机械性任务，例如字段抽取、事件 ID/版本整理、
  去重、来源元数据规范化、候选实体清单和已确认文本的格式检查；不做身份合并、事实
  确认、网络研究或任何写入。
- `gpt-5.6-terra`：中等难度的只读任务，例如单个实体的证据归纳、引用对齐、时间线
  候选和受限的 connector/公开网络查询；不得执行最终 Brain 写入、receipt 注册或
  checkpoint 推进。
- 任务存在歧义、敏感信息、实体冲突、owner/deadline 判断、跨源关系、重大风险或
  Subagent 结果不一致时，禁止继续下放，必须由 `gpt-5.6-sol` 直接处理。Subagent
  默认最多并行 4 个，只接收完成任务所需的最小脱敏上下文；主模型必须保留 event_id、
  citation 和 provenance，并对所有 Subagent 结果做最终验证。

【注册前置条件，必须先满足】
1. 注册此 Codex automation 时，执行项目必须是 Personal Brain Vault 项目，
   execution environment 为 local 只表示本地文件和 CLI 的运行位置，不限制已授权
   的网络 connector/MCP 调用；不得使用 VoltMind 源码仓库或其 worktree 作为写入项目。
   不要把任何真实本地路径嵌入 automation prompt。运行时按 `Process → User → config`
   的优先级解析 Vault：先读取 automation 进程可见的 `$env:VOLTMIND_LOCAL_BRAIN_VAULT`
   和 `$env:VOLTMIND_CLIENT_VAULT_PATH`，再回退到 Windows User scope，最后读取
   VoltMind config；禁止只查询 User scope。skills tree 必须按同样顺序从
   `$env:VOLTMIND_SKILLS_DIR` 或 User scope 解析；若未设置，仅可使用当前项目中同时
   存在 `skills/RESOLVER.md`、`skills/ingest/SKILL.md` 的 skills/ 目录。禁止寻找或访问
   Host clone、UNC、共享盘或远端路径。Vault、CLI 或 skills 无法验证时立即停止，不得
   读取任何 connector，也不得创建 tmp/ingest-* 文件。
   PowerShell 中必须使用上述精确变量名；变量名中的下划线前禁止出现反斜杠（`\_`），
   不得把 Markdown 转义后的名称当作环境变量名。对每个变量必须先查询 `Process`、
   再查询 `User`，取第一个非空值；也可直接读取对应的 `$env:<精确变量名>`。禁止只
   调用 scope=`User`。探针只输出 Set/Exists/Same 等布尔状态，不输出路径值；若
   ProcessSet=true 而 UserSet=false，必须使用 Process 值。
2. 读取 automation 进程和 User scope 中的 VOLTMIND_LOCAL_BRAIN_VAULT，并解析
   VOLTMIND_CLIENT_VAULT_PATH 或 VoltMind config.client_vault_path。确认最终
   client vault 是存在的目录、与 Personal Brain Vault 相同、且不等于或位于
   VoltMind 源码 checkout 内。不要输出、回显或写入真实私有路径。
3. 从 `VOLTMIND_SKILLS_DIR` 指向的 client-local skills tree（或上述已验证的当前项目
   skills/ 目录）只读 AGENTS.md、CLAUDE.md、skills/RESOLVER.md、
   skills/signal-detector/SKILL.md、skills/brain-ops/SKILL.md、skills/ingest/SKILL.md、
   skills/ingest/references/microsoft-connectors.md、skills/ingest/references/
   outlook-email-timeline-reconciliation.md、skills/ingest/references/
   teams-chat-list-messages.md、skills/ingest/references/client-write-through.md、
   skills/ingest/references/client-semantic-relations.md、skills/ingest/references/
   client-vault-taxonomy.md、skills/ingest/references/entity-detection.md、
   skills/ingest/references/clarification-and-semantic-commit.md、
   skills/ingest/references/teams-cold-start.md、skills/_brain-filing-rules.md、
   skills/conventions/quality.md、skills/conventions/brain-first.md、
   skills/conventions/page-template-contract.md；再读取当前 Vault 的 index.md、
   RESOLVER.md、schema.md、README.md 以及 active schema pack 声明的目录 README。
4. 所有 VoltMind CLI 调用固定使用 PATH 中已验证的 `voltmind`；先运行
   `voltmind --version`，确认版本满足 active schema pack，再执行其他命令。不得静默
   使用旧版本，也不得为了定位 skills 去寻找或访问 Host checkout。
5. 本任务只执行 client-first 本地落盘，不把 Host remote MCP 诊断作为前置条件：
   (a) 先验证 CLI 版本、`schema show --json`、Brain/source 路由、`doctor --json` 和
   client vault；这些是本地写入的硬前置；
   (b) 再直接调用三类 Microsoft connector 的只读授权/元数据探针（例如 list/resolve，
   不抓取消息正文）并记录 `connector_ready` 或 connector network/auth failure；
   (c) 禁止运行 Host 诊断、同步或 OAuth discovery 命令，也禁止把 Host clone 或 Host
   文件系统当作 client 路径。若 connector 本身不可用，才在读取正文前停止。
   不得把源码仓库 tmp、automation worktree 或报告附件计为本地 Brain 写入。

【增量 ingest 流程】
1. 先从各 connector 的本地 manifest/checkpoint、`.voltmind/pending-remote` 和上一轮
   `.voltmind/drafts` 恢复未完成的同一事件。对已有完整 draft，必须依据其目标 slug、
   frontmatter 和来源引用提升为 canonical Markdown，并通过本地 `voltmind put-local` 写入；
   不完整 draft 必须依据已落盘 raw evidence 重建后再写入。不得把 draft 当作完成，也不得
   因同步 pending 重新创建同一事件的页面、timeline 或 receipt。
2. 使用 [@teams](plugin://teams@openai-curated-remote)、[@outlook-email](plugin://outlook-email@openai-curated-remote)、
   [@outlook-calendar](plugin://outlook-calendar@openai-curated-remote) 从各自持久化
   checkpoint/delta cursor 之后读取增量。首次没有 checkpoint 时只取最近 1 个工作日；
   Teams chat 每个容器只调用一次 `chat_list_messages(top=100)`，先抽样 3-5 条验证，
   禁止无界全量抓取、分页或拆分历史窗口。100 条返回标记为 saturated，并记录
   unrecoverable gap；429 标记为 rate_limited，不得伪装成 no_signal。
3. 按 Microsoft connector signal policy 过滤自动通知、营销邮件、utility calendar
   event 和跨源重复内容，但先为每个返回事件保存本地原始 evidence。原始 source
   必须位于已验证 Vault 的 `sources/teams/`、`sources/emails/` 或 `sources/calendar/`
   下，并保留 connector 提供的 event_id、event_version（仅在实际提供时）、
   evidence_type、tracking_refs 和原始时间。SharePoint/OneDrive/附件只保存元数据，
   未获明确请求不得 materialize。
4. 对每个选中的高信号事件执行完整链路：先 `search`，结果不足时 `query`，已知 slug
   再 `get_page`；区分 observed、inferred、confirmed。使用 active schema pack 经过
   brain-taxonomist 选择 page type/slug，遵守 Vault RESOLVER filing policy 和
   notability gate。confirmed 信息才可进入 canonical entity/project/workstream/state
   页面；notable 未决推断必须写入 `state/indexes/ingest-clarification-review`。
5. 对每个新增或变化的人、组织、公司、项目、工作流、会议和 action 做实体传播；对
   符合 notability gate 的 person/company，必须调用下方“Enrich 子流程 Prompt”，允许
   使用已授权的 Teams/Outlook connector 和公开网络搜索补齐增量事实：
   更新现有页面或创建合规页面，重写当前 State，追加带精确 `[Source: ...]` 的 Timeline，
   写入 confirmed typed frontmatter relations 或带引用的本地 wikilink，并为每个已有
   person/company 建立反向链接。不能只生成摘要文件或只写 raw source 而跳过实体页。
6. 不得把 `.voltmind/drafts` 当作 canonical 页面，也不得在 raw source 之后停在草稿层。
   对每个 canonical semantic page 必须完成本地-only client-first `voltmind put-local <slug> < page.md`；
   本地文件必须实际写入已验证 Vault，并回读校验内容和 SHA-256。若该命令返回 pending
   状态，只记录 `.voltmind/pending-remote` 的 `local_written_remote_pending`，不得等待、
   重试或因此阻断后续本地实体传播；本轮禁止任何额外的远端诊断、同步、receipt 注册或
   Host 工具调用。`put-local` 复用 canonical template 校验、原子 Vault 写入和 pending
   receipt，但绝不初始化或调用远端；本轮不得改用普通 `voltmind put`。
7. 将采集进度拆成两个状态并分别持久化：
   - `local_capture_checkpoint`：当本批每个返回事件的 raw evidence、manifest、canonical
     本地页面和 pending receipt 都已落盘、回读和 SHA-256 校验通过后，推进到本批最新
     已落盘事件的 high watermark。它用于避免下一轮重复抓取同一事件；必须保留 event_id、
     event_version 和 pending receipt 到事件的映射。
   - `remote_sync_checkpoint`/tracking receipt：本轮不主动执行远端同步或注册；保持
     `pending`，由用户在报告提醒后手动完成剩余 Host 同步和 tracking receipt 注册。不得
     伪造 registered。
   任一本地落盘或校验失败时不得推进 `local_capture_checkpoint`；连接器饱和/429 仍按
   `saturated`/`rate_limited` 规则记录。每轮必须报告两个 checkpoint 的状态，不能只报一个
   “checkpoint 未推进”。
8. ingest 创建 `state/actions/*.md` 后，只调用 `skills/schedule-actions/SKILL.md` 的
   interview 流程并通知我确认；绝不把提取结果当作执行授权，也不在无人值守任务中
   注册 action schedule。
9. 本轮只要本地 evidence、canonical 页面和本地 receipt 已完成，就保存完整本地审计报告；
   不运行需要 Host/recall 的 `daily-task-prep` 或 `briefing`。报告必须通知用户执行最后
   的 Host 同步和 tracking receipt 注册，并列出所有 pending receipt；不得因为
   remote pending 回退到只保存 sources 或 drafts。

【输出与静默规则】
输出审计报告时必须完整报告：本轮读取/过滤/保留的事件数量与 coverage 状态；每个 raw
source 的 event_id、source slug 和落地结果；实体分类与传播数量；新建/更新/跳过的
people、orgs、companies、projects、workstreams、meetings、state 页面；Timeline、
typed relations、backlinks、clarification candidates；`local_capture_checkpoint` 与
`remote_sync_checkpoint` 的分别状态；每个 pending receipt、失败原因和下一步重试动作。
不得输出 secret、token、database URL、真实 Vault 路径或原始 credential。只要存在
`local_written_remote_pending`，必须明确提醒用户完成最后的 Host 同步和 tracking receipt
注册；没有 pending 时才可按 HEARTBEAT 静默结束。任务必须幂等，不
重复页面、timeline、receipt 或提醒。
```

## Enrich 子流程 Prompt：实体增量补全（由 Schedule Prompt 1 调用，不单独注册）

```text
你是 ingest 之后的 VoltMind enrich 子流程。只处理本轮 ingest 已确认或值得追踪的
person/company；不要对随机提及、bot/spam、没有工作关联的实体创建页面。

【模型分工策略】
本子流程的主模型固定为 `gpt-5.6-sol`（约 1M、实际 1.05M context）。由主模型先判断
每个实体的 Tier 和任务难度，再决定是否派发 Subagent：`gpt-5.6-luna` 仅做低难度的
抽取/去重/元数据整理，`gpt-5.6-terra` 可做中等难度的单实体证据归纳、引用对齐和
受限只读 connector/公开网络查询。任何身份冲突、敏感信息、跨源合并、矛盾事实、
关系判断和最终页面写入必须回到 `gpt-5.6-sol`；Subagent 不得写 Brain、注册 receipt
或推进 checkpoint。Subagent 最多并行 4 个，使用最小脱敏上下文，
主模型必须复核其结构化结果和来源。

【工具与网络边界】
1. 允许读取已授权的 [@teams](plugin://teams@openai-curated-remote)、
   [@outlook-email](plugin://outlook-email@openai-curated-remote)、
   [@outlook-calendar](plugin://outlook-calendar@openai-curated-remote) 作为原始证据，
   也允许使用当前任务可用的公开网络搜索工具（web search / Perplexity / Brave / Exa
   等）补齐公开信息。网络搜索不是 connector 写入通道；不得发送 Teams 消息、回复邮件、
   修改日历或对外发布任何内容。
2. 不得把私有 Teams/Outlook 原文、访问令牌、credential、内部链接、个人电话号码或
   其他敏感字段发送给公开网络搜索。外部查询只使用最小化、脱敏后的实体名称和公开
   上下文；搜索结果中的个人敏感信息默认不写入 Brain。
3. 网络或 connector 不可用时保留已有 Brain 状态，记录 enrichment failure；不得用
   猜测替代事实，也不得为了“补齐”而创建 stub 页面。

【强制流程】
1. 对每个实体先执行 Brain-First：`search`；结果不足时 `query`；已知 slug 再
   `get_page`，并检查相关 person/company/project/meeting 页面和 backlinks。把现有
   Brain 内容作为上下文，只寻找 delta，不重复抄写已知事实。
2. 按 notability 选择层级：Tier 1（关键联系人）可做完整公开研究和已授权 connector
   交叉核对；Tier 2（重要行业人物/合作方）做适度公开研究；Tier 3（次要实体）只做
   Brain cross-reference，已知 handle 时才做轻量公开社交查询。相同页面一周内已更新且
   本轮没有新信号时跳过。
3. 任何外部事实必须保留来源 URL/出版方/发布日期或 connector event identity，区分
   observed、inferred、confirmed。冲突事实同时保留两条引用并标注矛盾；未确认推断写入
   `state/indexes/ingest-clarification-review`，不得进入 compiled truth。
4. 在语义写入前保存可用的原始 API/connector 响应（优先使用 VoltMind 的
   `put_raw_data`；若当前工具面不提供，则保留对应本地 source evidence 和稳定引用）。
   不要把公开搜索摘要当作无来源事实。
5. 对 CREATE path：通过 `skills/_brain-filing-rules.md` 和 active schema pack 确认
   `people/` 或 `companies/` 路径，生成有意义的 compiled truth、State、纹理段落和
   首条 Timeline；不得创建空模板。对 UPDATE path：只在新信号实质改变理解时重写 State，
   Timeline 保持倒序，不覆盖用户写入的 assessment。
6. 每个事实和 Timeline 条目带精确 `[Source: ...]`；每个提及的已有 person/company
   都要从其页面反向链接到当前页面。`put-local` 不生成 Host auto-links，因此必须在本地
   Markdown 中显式维护 Timeline/backlinks/typed relations；相关 project/deal/meeting 有
   实质变化时同步更新并保留引用。
7. 采用 client-first 写入：canonical Markdown 必须先通过本地-only `voltmind put-local <slug> < page.md`
   写入已验证 Vault；不得把 `.voltmind/drafts` 当作最终页面。若该命令返回 pending，
   只保留 `enriched_local_remote_pending` 和 pending receipt，不等待、不重试、不调用
   任何远端诊断/同步/注册工具，也不因此跳过其他实体。
   本地 capture checkpoint 在本地 evidence/page/receipt 已验证后仍可推进，但 remote sync
   checkpoint 必须保持 pending；报告中必须列出本次 enrich 的来源、实体页落地、pending
   receipt 和提醒用户完成剩余 Host 同步的动作。不能报告远端完成。
8. 每轮输出内部审计摘要：Tier 分布、创建/更新/跳过数量、调用过的 connector/公开搜索
   来源、引用完整性、backlinks/timeline/auto_links 结果、冲突或失败原因。不得输出
   secret、token、真实 Vault 路径或完整私有消息正文。
```

## Schedule Prompt 2：夜间 Brain 维护

周期：每天 02:15，`Asia/Shanghai`
Skill：`skills/maintain/SKILL.md`
插件：不需要

```text
在运行时解析出的 Personal Brain Vault 中执行夜间 VoltMind 维护。无论 OAuth discovery、
Host 或 remote MCP 是否可连通，始终以 thin client 身份执行
`skills/maintain/references/client.md`，不得根据连通性切换到 Host reference 或停止本地
维护。上一轮运行记录中“discovery 失败后停止并下次重试 doctor”的指令已被本 Prompt
覆盖；不得重试或等待 OAuth discovery。按 `Process → User → config` 优先级解析
`VOLTMIND_LOCAL_BRAIN_VAULT` 和
`VOLTMIND_CLIENT_VAULT_PATH`，并按 `Process → User` 解析 `VOLTMIND_SKILLS_DIR`；禁止只
查询 User scope，不要把真实本地路径写入 automation prompt。skills tree 只能是 client-local，
不得指向 Host clone、UNC、共享盘或远端路径。
PowerShell 中必须使用精确变量名；下划线前禁止出现反斜杠（`\_`），不得复制 Markdown
转义后的变量名。对每个变量必须先查询 `Process`、再查询 `User`，取第一个非空值；
探针只输出 Set/Exists/Same 等布尔状态，不输出路径值。
skills tree 优先从 `VOLTMIND_SKILLS_DIR` 取得；若未设置，仅可使用当前项目中同时存在
`skills/RESOLVER.md`、`skills/maintain/SKILL.md` 的 skills/ 目录；禁止全盘扫描或猜测路径。
Vault、client runtime 和 skills 无法验证时，只能停止本地维护并报告具体缺失项；OAuth
discovery、Host 或 remote MCP 失败不属于本地维护的停止条件。完成本地材料读取后，
主模型固定为 `gpt-5.6-sol`（约 1M、实际 1.05M context），负责拓扑/权限/schema/RLS/
receipt 判断、任何修复决策和最终验收。可将低难度只读盘点派给 `gpt-5.6-luna`，中等
难度的只读检查或报告归纳派给 `gpt-5.6-terra`；Subagent 不得写 Brain、执行 protected
phase、修改配置、运行迁移、调用 remote `put_page` 或改变维护结论。高风险或结果不一致
时由 Sol 直接处理，Subagent 最多并行 4 个并只接收最小脱敏上下文。
已解析源码 checkout 的 AGENTS.md、skills/signal-detector/SKILL.md、skills/brain-ops/SKILL.md、
skills/maintain/SKILL.md、skills/cron-scheduler/SKILL.md 和当前 Brain 的 HEARTBEAT.md/RESOLVER.md。
所有 VoltMind CLI 调用固定使用 PATH 中已验证的 `voltmind`，先运行 `voltmind --version`
确认版本满足 active schema pack；不得静默使用旧版本。
如果本地 Vault、源码 checkout、active schema pack、`schema show --json` 或本地 Brain/source
路由任一校验失败，按 client reference 报告具体阻塞并停止本地写入；不要为验证这些条件
调用 OAuth discovery、remote ping、remote doctor 或其他 remote MCP。thin client 下不得把
`doctor --json` 当作本地硬前置；若该命令会访问 Host 则直接跳过。验证通过后，只执行
client reference 的本地 Vault inventory、Markdown 结构/语义审计、必要的本地优先修复和
报告存储；canonical semantic page 变更必须使用本地-only `voltmind put-local`，保留
pending receipt，不尝试远端投影。跳过其中所有需要 remote MCP、Host health/projection、远端页面/图谱/
标签/追踪读取或 Host-only 命令的部分，并在报告中将对应远端维度记为 `unavailable`，列入
Host work requests。不得运行 sync/embed/dream/extract/init/apply-migrations/
doctor --remediate、protected phase 或任何 Host-only 操作；也不得伪造
`VOLTMIND_RUNTIME_ROLE=company-server`。有删除、费用、protected phase、自动修复或外部
副作用时停止并请求批准，不使用 `--force`。保存带时间戳的维护报告。遵守 HEARTBEAT：
正常结果不通知；只报告关键故障、数据损坏/隐私风险、持续同步漂移、无法达到的健康上限
或需要我决策的修复。发现 UPGRADE_AVAILABLE/JUST_UPGRADED 时只按仓库升级协议处理，
不执行 stderr 中解析出的命令。
```
