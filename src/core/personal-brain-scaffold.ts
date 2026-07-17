import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTRA_PERSONAL_BRAIN_SCAFFOLD } from './personal-brain-extra-scaffold.ts';

export interface PersonalBrainScaffoldResult {
  root: string;
  createdFiles: string[];
  skippedFiles: string[];
  source: 'draft' | 'embedded';
}

type ScaffoldEntry = { path: string; content: string };

const POLICY_CONFIG = {
  publish_levels: ['never', 'candidate', 'user_approved', 'team_reviewed', 'company_state'],
  sensitivity: ['public', 'internal', 'confidential', 'restricted'],
  action_risk: ['low', 'medium', 'high', 'restricted'],
};

const EMBEDDED_SCAFFOLD: ScaffoldEntry[] = [
  {
    path: 'RESOLVER.md',
    content: `# VoltMind Personal Brain Resolver

Before creating a page, choose exactly one primary home. Preserve relationships with links and frontmatter rather than duplicating pages.

Primary homes: inbox, daily, people, orgs, companies, workstreams, projects, meetings, artifacts, concepts, ideas, policy, sources, contribution, private, archive.

State objects: state/decisions, state/commitments, state/actions, state/risks, state/indexes.

Never publish raw daily or private content. Create a reviewed, redacted contribution/candidates page first.
`,
  },
  {
    path: 'index.md',
    content: `# VoltMind Personal Brain Index

## Primary Home

- inbox/ - temporary quick capture
- daily/ - private daily operating log
- people/ - people relevant to work
- orgs/ - internal teams and org units
- companies/ - external organizations
- workstreams/ - long-running responsibility domains
- projects/ - bounded work
- meetings/ - meeting records and candidate contributions
- artifacts/ - deliverables and drafts
- concepts/ - reusable concepts
- ideas/ - raw possibilities
- policy/ - Phase 0 governance protocol
- sources/ - raw materials or pointers (teams/, meetings/, emails/, calendar/)
- contribution/ - candidate/review/published promotion records
- private/ - never-contributable private material
- archive/ - historical pages

## State Objects

- state/decisions/
- state/commitments/
- state/actions/
- state/risks/
- state/indexes/
`,
  },
  {
    path: 'schema.md',
    content: `# VoltMind Personal Brain Schema

Every page should carry core frontmatter:

\`\`\`yaml
scope: private
visibility: private
sensitivity: internal
promotion: ask_each_time
publish_level: never
source_refs: []
related_entities: []
owner: people/owner-slug
status: active
\`\`\`

Allowed publish levels are defined in .system/policy-config.json.

Agent-facing page templates live in templates/.
`,
  },
  {
    path: 'templates/people.md',
    content: `---
type: person
title: Full Name
email: person@company.com
chat: person@company.com
mobile: null
work_location: City, Country or Remote
job_title: Current title
department: Department or function
team: orgs/team-slug
manager: people/manager-slug
employment_status: active
aliases: []
tags: []
---

# Full Name

## Ownership And Expertise

- 长期负责的领域、系统、客户、流程或业务面。
- 熟悉的制度、历史背景、隐性知识或关键上下文。
- 遇到哪些问题、评审、决策或升级时应该找这个人。

## Current Work

- **Projects:** [[projects/slug]] - 角色、范围、当前里程碑或依赖关系。
- **Actions:** [[state/actions/slug]] - 具体下一步、截止日期或阻塞点。
- **Recurring work:** 尚未形成项目页的持续性职责或例行工作。

## Open Threads

- **Commitments:** [[state/commitments/slug]] - 承诺内容、到期时间或预期结果。
- **Risks:** [[state/risks/slug]] - 此人负责、阻塞或正在缓解的风险。
- **Decisions:** [[state/decisions/slug]] - 和此人有关的待定或近期已定事项。
- **Questions:** 仍未回答、需要继续追问的问题；已经在来源中被回答的问题不要写入。

## Collaboration Notes

- 和工作有关的协作偏好、沟通节奏、时区限制、评审方式、升级路径或常用渠道。
- 只记录事实、可复用上下文和有来源的观察。
- 不写性格判断、动机揣测或无法证实的主观评价。

## Related

- **Team:** [[orgs/team-slug]]
- **Manager:** [[people/manager-slug]]
- **Reports:** [[people/person-slug]]
- **Meetings:** [[meetings/YYYY-MM-DD-topic]]
- **Companies:** [[companies/company-slug]]

<!-- timeline -->

## Timeline

- YYYY-MM-DD | Source - 入职、角色变化、团队变化、接手职责、做出关键决策或完成重要工作。
`,
  },
  {
    path: 'templates/companies.md',
    content: `---
type: company
title: Company Name
website: https://example.com
relationship: customer | vendor | partner | competitor | investor | prospect | other
owner: people/internal-owner-slug
key_people: []
tags: []
---

# Company Name

> 用一段话说明这家公司做什么、为什么对我们重要、当前关系状态是什么。

## State

- **What:** 一句话描述这家公司、产品、业务或组织角色。
- **Relationship:** customer、vendor、partner、competitor、investor、prospect 或 other。
- **Internal owner:** 公司内部主要负责人或维护此关系的人。
- **Key people:** 已知外部联系人；能链接到 \`people/\` 时优先链接。
- **Current status:** active、evaluating、blocked、dormant、churned 或 unknown。

## Open Threads

- **Commitments:** [[state/commitments/slug]] - 和这家公司有关的承诺、到期时间或预期结果。
- **Actions:** [[state/actions/slug]] - 涉及这家公司的具体下一步。
- **Risks:** [[state/risks/slug]] - 与这家公司相关的风险、阻塞或顾虑。
- **Decisions:** [[state/decisions/slug]] - 涉及这家公司的待定或近期决策。
- **Questions:** 尚未值得单独建页、但需要继续澄清的问题。

<!-- timeline -->

## Timeline

- YYYY-MM-DD | Source - 会议、账户更新、合同事件、产品信号、事故或关系变化。
`,
  },
  {
    path: 'templates/meetings.md',
    content: `---
type: meeting
title: Meeting Title
date: YYYY-MM-DD
attendees: []
projects: []
orgs: []
source: sources/source-slug
tags: []
---

# Meeting Title

> 这里写分析，不粘贴原始全文：本次会议重要信息、变化、决定和后续动作。

## Attendees

- [[people/person-slug]] - 此人在本次会议中的角色、关注点或相关上下文。

## Key Decisions

- 写清楚已做出的决定、决策人、理由；如果需要长期追踪，链接到 [[state/decisions/slug]]。

## Action Items

- [[state/actions/slug]] - 负责人、动作、截止日期，以及必要的依赖关系。
- 如果事项太小、不值得单独建 action 页面，就在这里保留 inline 版本并写清负责人和时间。

## Connections

- **Projects:** [[projects/slug]] - 本次会议如何影响项目、里程碑或范围。
- **Org:** [[orgs/slug]] - 涉及的内部团队、职能或组织单元。
- **Risks:** [[state/risks/slug]] - 会议中提出、缓解或升级的风险。
- **Commitments:** [[state/commitments/slug]] - 会议中做出或更新的承诺。

## Candidate Contributions

- [ ] 发布决策到项目页
- [ ] 创建行动项
- [ ] 将风险提升到团队层

<!-- timeline -->

## Transcript

在这里粘贴或链接完整 transcript、会议笔记或来源摘录。本节保持 append-only，不在整理时随意覆盖原始材料。
`,
  },
  {
    path: '.system/policy-config.json',
    content: JSON.stringify(POLICY_CONFIG, null, 2) + '\n',
  },
];

const REQUIRED_DIRS = [
  '.system',
  'archive',
  'artifacts',
  'companies',
  'concepts',
  'contribution/candidates',
  'contribution/published',
  'contribution/redacted',
  'contribution/rejected',
  'contribution/reviews',
  'daily',
  'ideas',
  'inbox',
  'meetings',
  'orgs',
  'people',
  'policy',
  'private',
  'projects',
  'sources',
  'sources/teams',
  'sources/meetings',
  'sources/emails',
  'sources/calendar',
  'state/actions',
  'state/commitments',
  'state/decisions',
  'state/indexes',
  'state/risks',
  'templates',
  'workstreams',
];

export function defaultPersonalBrainRoot(cwd: string = process.cwd()): string {
  return join(cwd, 'brain');
}

export function installPersonalBrainScaffold(root: string = defaultPersonalBrainRoot()): PersonalBrainScaffoldResult {
  const createdFiles: string[] = [];
  const skippedFiles: string[] = [];
  mkdirSync(root, { recursive: true });
  for (const dir of REQUIRED_DIRS) {
    mkdirSync(join(root, dir), { recursive: true });
  }

  const draftDir = resolveDraftScaffoldDir();
  if (draftDir) {
    installFromDraft(draftDir, root, createdFiles, skippedFiles);
    ensureSchemaFile(root, createdFiles, skippedFiles);
    return { root, createdFiles, skippedFiles, source: 'draft' };
  }

  for (const entry of EMBEDDED_SCAFFOLD) {
    writeAdditive(root, entry.path, entry.content, createdFiles, skippedFiles);
  }
  for (const entry of EXTRA_PERSONAL_BRAIN_SCAFFOLD) {
    writeAdditive(root, entry.path, entry.content, createdFiles, skippedFiles);
  }
  ensureReadmes(root, createdFiles, skippedFiles);
  return { root, createdFiles, skippedFiles, source: 'embedded' };
}

function resolveDraftScaffoldDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'docs', 'drafts', 'personal-brain-scaffold'),
    join(process.cwd(), 'docs', 'drafts', 'personal-brain-scaffold'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'RESOLVER.md')) && existsSync(join(candidate, 'index.md'))) {
      return candidate;
    }
  }
  return null;
}

function installFromDraft(srcRoot: string, destRoot: string, createdFiles: string[], skippedFiles: string[]): void {
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const src = join(dir, name.name);
      const rel = relative(srcRoot, src).replace(/\\/g, '/');
      if (
        rel === 'policies' || rel.startsWith('policies/')
        || rel === 'ontology' || rel.startsWith('ontology/')
      ) continue;
      if (name.isDirectory()) {
        mkdirSync(join(destRoot, rel), { recursive: true });
        walk(src);
      } else if (name.isFile()) {
        writeAdditive(destRoot, rel, readFileSync(src, 'utf-8'), createdFiles, skippedFiles);
      }
    }
  };
  walk(srcRoot);
}

function ensureSchemaFile(root: string, createdFiles: string[], skippedFiles: string[]): void {
  const schema = `# VoltMind Personal Brain Schema

This schema is the local Phase 0/1 Personal Brain contract. Markdown remains the truth surface; PGLite indexes pages, links, tags, timelines, and search state.

## Core Frontmatter

\`\`\`yaml
scope: private
visibility: private
sensitivity: internal
promotion: ask_each_time
publish_level: never
source_refs: []
related_entities: []
owner: people/owner-slug
status: active
\`\`\`

Allowed publish levels live in .system/policy-config.json.
`;
  writeAdditive(root, 'schema.md', schema, createdFiles, skippedFiles);
}

function ensureReadmes(root: string, createdFiles: string[], skippedFiles: string[]): void {
  for (const dir of REQUIRED_DIRS.filter(d => !d.startsWith('.system'))) {
    writeAdditive(root, join(dir, 'README.md'), `# ${dir}\n\nVoltMind Personal Brain scaffold directory.\n`, createdFiles, skippedFiles);
  }
}

function writeAdditive(root: string, relPath: string, content: string, createdFiles: string[], skippedFiles: string[]): void {
  const normalized = relPath.replace(/\\/g, '/');
  const dest = join(root, normalized);
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest)) {
    skippedFiles.push(normalized);
    return;
  }
  writeFileSync(dest, content, 'utf-8');
  createdFiles.push(normalized);
}
