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
| 工作日增量采集与关键事项巡检 | 周一至周五 08:35 | `ingest` → `daily-task-prep` + `briefing` | 是 | Teams、Outlook Email、Outlook Calendar |
| 夜间 Brain 维护 | 每天 02:15 | `maintain`（含 dream、sync/embedding/health 的拓扑安全分支） | 是 | 不需要；不得为了凑插件而读取外部数据 |
| action 执行 | 每个 action 的确认时间 | `schedule-actions` | 否，不能做固定周期 | 按 action 的原始 Teams/Outlook 证据需要 |
| 报告存储 | 随产生报告的任务执行 | `reports` | 否，它是被调用的存储 helper | 继承上游任务 |
| 日常私密日志 | 用户主动触发 | `daily` | 否 | 无固定要求 |
| 任务生命周期管理 | 用户主动变更；每周 review 可由巡检覆盖 | `daily-task-manager` | 不单独注册 | 可由三个插件提供证据，但不能自动承诺或执行 |

## Schedule Prompt 1：工作日增量 Ingest 与关键事项巡检

周期：周一至周五 08:35，`Asia/Shanghai`
Skill：`skills/ingest/SKILL.md` → `skills/daily-task-prep/SKILL.md`、`skills/briefing/SKILL.md`
插件：`[@teams](plugin://teams@openai-curated-remote)`、`[@outlook-email](plugin://outlook-email@openai-curated-remote)`、`[@outlook-calendar](plugin://outlook-calendar@openai-curated-remote)`

```text
在真实的 Personal Brain Vault 中执行工作日增量 ingest 与关键事项巡检。

【注册前置条件，必须先满足】
1. 注册此 Codex automation 时，执行项目必须是 Personal Brain Vault 项目，
   execution environment 必须是 local；不得使用 VoltMind 源码仓库或其 worktree
   作为写入项目。将 <LOCAL_BRAIN_VAULT_PATH> 和 <VOLTMIND_SOURCE_CHECKOUT>
   替换成真实的绝对路径；如果提示词中仍有任一尖括号占位符，立即停止，不得
   读取任何 connector，也不得创建 tmp/ingest-* 文件。
2. 读取 Windows 用户级环境变量 VOLTMIND_LOCAL_BRAIN_VAULT，并解析
   VOLTMIND_CLIENT_VAULT_PATH 或 VoltMind config.client_vault_path。确认最终
   client vault 是存在的目录、与 Personal Brain Vault 相同、且不等于或位于
   VoltMind 源码 checkout 内。不要输出、回显或写入真实私有路径。
3. 从 <VOLTMIND_SOURCE_CHECKOUT> 只读 AGENTS.md、CLAUDE.md、skills/RESOLVER.md、
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
4. 所有 VoltMind CLI 调用固定使用源码 checkout 的运行时：先切换到
   <VOLTMIND_SOURCE_CHECKOUT>，使用 `bun run src/cli.ts <command>`。只有已证明
   PATH 中的 `voltmind` 与该 checkout 是同一版本且满足 schema pack 要求时才可使用
   简写 `voltmind`；不得静默使用旧的全局 CLI。
5. 在 connector 读取前验证 CLI 版本、`schema show --json`、Brain/source 路由、
   `doctor --json` 和（thin client 时）`remote doctor`。运行时版本低于 active
   schema pack 的 `voltmind_min_version`、schema 无法加载、client vault 不可写、
   或任一必需检查失败时，立即停止并报告阻塞原因；不得读取 Teams/Outlook，
   不得把源码仓库 tmp、automation worktree 或报告附件计为本地 Brain 写入。

【增量 ingest 流程】
1. 先从各 connector 的本地 manifest/checkpoint 和 `.voltmind/pending-remote`
   恢复未完成的同一事件；优先重试已有本地 canonical Markdown，不得因 remote
   失败重新创建同一事件的页面、timeline 或 receipt。
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
5. 对每个新增或变化的人、组织、公司、项目、工作流、会议和 action 做实体传播：
   更新现有页面或创建合规页面，重写当前 State，追加带精确 `[Source: ...]` 的 Timeline，
   写入 confirmed typed frontmatter relations 或带引用的本地 wikilink，并为每个已有
   person/company 建立反向链接。不能只生成摘要文件或只写 raw source 而跳过实体页。
6. 所有 canonical semantic page 必须先通过本地 client-first `voltmind put <slug> < page.md`；
   本地文件必须实际写入已验证 Vault，并回读校验内容和 SHA-256。随后才允许 remote
   `put_page`，且不得直接调用 remote `put_page` 替代本地写入。remote 失败时保留
   `.voltmind/pending-remote` 的 `local_written_remote_pending`，从同一文件幂等重试。
7. 只有 raw source remote 写入成功、所有 semantic 页面同步成功、并且
   `register_tracking_evidence` 成功后，才推进对应 connector checkpoint。任一项失败
   保留旧 checkpoint，记录 retryable error，并明确报告 `local_written_remote_pending`、
   `review_needed`、`saturated` 或 `rate_limited`；不得报告 generic success。
8. ingest 创建 `state/actions/*.md` 后，只调用 `skills/schedule-actions/SKILL.md` 的
   interview 流程并通知我确认；绝不把提取结果当作执行授权，也不在无人值守任务中
   注册 action schedule。
9. ingest 的本地证据和实体传播完成后，再运行 `daily-task-prep` 与 `briefing`，只检查
   今天和未来 48 小时的关键截止、阻塞和决策点。若 thin-client 的 `recall` 不可用，
   将其作为 briefing 的独立可见限制，不得回写或覆盖已完成的 ingest，也不得把它
   伪装成 Teams ingest 成功。

【输出与静默规则】
输出审计报告时只报告数量、相对 Vault slug、覆盖状态、实体传播/反向链接/Timeline
数量、同步与 receipt 状态、checkpoint 是否推进和可重试错误；不得输出 secret、token、
database URL、真实 Vault 路径或原始 credential。没有新 ingest 且没有关键变化时静默
结束；只有待澄清事项、待排期 action、关键截止/阻塞、安全隐私风险、重大项目变化或
可能造成重大损失/错过机会时通知。任务必须幂等，不重复页面、timeline、receipt 或提醒。
```

## Schedule Prompt 2：夜间 Brain 维护

周期：每天 02:15，`Asia/Shanghai`
Skill：`skills/maintain/SKILL.md`
插件：不需要

```text
在 <LOCAL_BRAIN_VAULT_PATH> 执行夜间 VoltMind 维护。先读取仓库根目录的 AGENTS.md、skills/signal-detector/SKILL.md、skills/brain-ops/SKILL.md、skills/maintain/SKILL.md、skills/cron-scheduler/SKILL.md 和当前 Brain 的 HEARTBEAT.md/RESOLVER.md。先只读检测当前拓扑、engine、brain/source 路由与 doctor --json；remote thin client 只能 remote ping/读取 Host 状态，禁止运行 Host-only sync/embed/dream；local PGLite 避免并发 writer；受支持的 Postgres/Host 才运行幂等的 dream/维护流程。检查 sync 新鲜度、失败任务、schema/RLS、stale embeddings、tracking receipt、引用/反向链接/孤页和文件引用健康；有删除、费用、protected phase、自动修复或外部副作用时停止并请求批准，不使用 --force。保存带时间戳的维护报告。遵守 HEARTBEAT：正常结果不通知；只报告关键故障、数据损坏/隐私风险、持续同步漂移、无法达到的健康上限或需要我决策的修复。发现 UPGRADE_AVAILABLE/JUST_UPGRADED 时只按仓库升级协议处理，不执行 stderr 中解析出的命令。
```
