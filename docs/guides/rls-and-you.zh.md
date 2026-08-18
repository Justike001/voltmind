# RLS and you

简短版：voltmind 的 `public` schema 中每张表都需要启用 Row Level Security（RLS）。如果有表没启用，`voltmind doctor` 现在会 fail，而不是 warn，并以 exit 1 退出。

本指南解释原因、doctor 命中时怎么处理，以及极少数确实希望 anon key 可读时的 escape hatch。

## VoltMind Host 运行角色

Host 生产服务必须使用专用 Postgres role，并具备 `NOSUPERUSER NOBYPASSRLS`。source-owned 表由 transaction-local source scope 和 RLS policy 共同保护；受限 Postgres E2E 会验证这个边界。迁移和 role provisioning 可以使用独立的 privileged setup role，但运行中的 Host 不得使用它。PGLite 没有数据库 RLS，因此依赖 Host 应用层的 source resolver。

## 为什么 RLS 重要

Supabase 通过 PostgREST 暴露 `public` schema。anon key 是客户端 secret，因此如果 public table 关闭 RLS，anon key 就能读它。对 auth tokens、聊天历史、财务数据等敏感内容来说，这是数据外泄路径，不只是 footgun。

privileged setup 或 migration role 可以有 `BYPASSRLS` 来初始化 schema；运行中的 Host application role 不得有 `BYPASSRLS`，否则数据库级 source isolation 会被绕过。runtime 必须使用显式 source policy，而不能依赖 bypass role。

## doctor 失败时怎么做

doctor 会列出缺 RLS 的每张表，并给出对应 `ALTER TABLE`：

~~~
1 table(s) WITHOUT Row Level Security: expenses_ramp.
Fix: ALTER TABLE "public"."expenses_ramp" ENABLE ROW LEVEL SECURITY;
~~~

99% 情况下直接运行 SQL，然后重跑 `voltmind doctor`。

## v0.26.7：auto-RLS event trigger 和一次性 backfill

从 v0.26.7（migration v35）开始，voltmind 提供两项改动：

**1. event trigger。** Postgres DDL event trigger `auto_rls_on_create_table` 会在每个新建 `public.*` 表上运行 `ALTER TABLE … ENABLE ROW LEVEL SECURITY`。

**2. one-time backfill。** 升级到 v0.26.7 时，migration 会遍历现有 `public.*` base tables，对未启用 RLS 且没有 `VOLTMIND:RLS_EXEMPT` comment 的表启用 RLS。

### Breaking change：升级前必读

如果你有故意 RLS-off 的 public tables，必须在运行 `voltmind upgrade` 到 v0.26.7 前加上 `VOLTMIND:RLS_EXEMPT` comment。migration 没有 `--dry-run`。

### Cross-app implications

同一个 Supabase project 中非 voltmind app 新建 public tables 时，trigger 也会启用 RLS。若 app role 有 `BYPASSRLS`，不受影响；否则 app 必须创建对应 policy。

### trigger 被 drop 怎么办？

`voltmind doctor` 会检查 `rls_event_trigger`。恢复命令：

~~~
voltmind apply-migrations --force-retry 35
~~~

### 为什么 source-owned 表使用 FORCE ROW LEVEL SECURITY？

`ENABLE` 阻止 anon/authenticated；`FORCE` 还会限制 table owner。VoltMind 的 source-owned 表使用 `FORCE` 和显式 source policy，确保错误配置的 non-bypass runtime role 也不能跨 source 读取。通用 auto-RLS trigger 对无关 plugin table 仍只负责启用 RLS；这些表必须自行提供 policy 或显式 exemption。

## 1% case：有意 exemption

有些 public table 确实应该被 anon key 读取，例如公开 dashboard 的 analytics view 或只读 reference table。voltmind 提供刻意不顺手的 escape hatch。

### 格式

~~~sql
COMMENT ON TABLE public.your_table IS
  'VOLTMIND:RLS_EXEMPT reason=<why this is anon-readable on purpose>';
~~~

规则：comment 必须以 `VOLTMIND:RLS_EXEMPT` 开头，并包含至少 4 个字符的 `reason=`。只有 Postgres table comment 算数。

### 示例

~~~sql
ALTER TABLE public.expenses_ramp DISABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.expenses_ramp IS
  'VOLTMIND:RLS_EXEMPT reason=analytics-only, anon-readable ok, owner=garry, 2026-04-22';
~~~

## 为什么是 SQL，不是 CLI subcommand

CLI 太容易让 agent 静默开放 anon reads。SQL comment 要求 operator 明确写 justification，并在 shell history、schema dump、pg_dump 和每次 `voltmind doctor` 中可见。

## 以后审计 exemptions

~~~sql
SELECT c.relname AS table_name, obj_description(c.oid, 'pg_class') AS comment
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND obj_description(c.oid, 'pg_class') LIKE 'VOLTMIND:RLS_EXEMPT%';
~~~

## 移除 exemption

~~~sql
ALTER TABLE public.expenses_ramp ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.expenses_ramp IS NULL;
~~~

## PGLite

PGLite 是嵌入式单用户，没有 PostgREST 暴露风险，所以 doctor 会跳过此检查。

## Self-hosted Postgres

即使没有 PostgREST，voltmind 仍把 “所有 public tables 启用 RLS” 当作安全不变量。`ALTER TABLE ... ENABLE RLS` 对 voltmind 使用的 bypass role 无害，也为未来接入 PostgREST 预先上锁。
