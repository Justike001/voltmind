import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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
- sources/ - raw materials or pointers
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
  'state/actions',
  'state/commitments',
  'state/decisions',
  'state/indexes',
  'state/risks',
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
      if (rel === 'policies' || rel.startsWith('policies/')) continue;
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
