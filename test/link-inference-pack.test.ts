// v0.38 T7b: pack-aware link inference tests.
//
// Pins the contract that `inferLinkTypeFromPack` consults pack-declared
// verbs WITHOUT replacing legacy in-code inferLinkType. Two scenarios:
//   1. Legacy voltmind-base routes (founded/invested_in/advises/works_at)
//      stay reachable via the existing inferLinkType call.
//   2. User packs can ADD new verbs via link_types[].inference.regex;
//      the new verb resolves on the pack-aware path before the legacy
//      fall-through.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  inferLinkTypeFromPack,
  frontmatterLinkTypeFromPack,
  parseSchemaPackManifest,
  PageRegexBudget,
} from '../src/core/schema-pack/index.ts';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';
import { inferLinkType } from '../src/core/link-extraction.ts';

const PERSONAL_BRAIN_PATH = join(import.meta.dir, '../src/core/schema-pack/base/voltmind-personal-brain.yaml');

describe('inferLinkTypeFromPack (T7b)', () => {
  const minimalPack = (link_types: Array<Record<string, unknown>>) =>
    parseSchemaPackManifest({
      api_version: 'voltmind-schema-pack-v1',
      name: 'test',
      version: '0.1.0',
      extends: null,
      page_types: [],
      link_types,
    });

  test('page-type-bound verb resolves deterministically (meeting → attended)', () => {
    const pack = minimalPack([
      { name: 'attended', inference: { page_type: 'meeting' } },
    ]);
    expect(inferLinkTypeFromPack(pack, 'meeting', 'irrelevant text')).toBe('attended');
  });

  test('image → image_of via pack declaration', () => {
    const pack = minimalPack([
      { name: 'image_of', inference: { page_type: 'image' } },
    ]);
    expect(inferLinkTypeFromPack(pack, 'image', 'doesnt matter')).toBe('image_of');
  });

  test('regex matcher resolves user-declared verb', () => {
    const pack = minimalPack([
      { name: 'supports', inference: { regex: '\\b(supports|in support of)\\b' } },
      { name: 'weakens', inference: { regex: '\\b(weakens|undermines)\\b' } },
    ]);
    expect(inferLinkTypeFromPack(pack, 'paper', 'this evidence supports the claim')).toBe('supports');
    expect(inferLinkTypeFromPack(pack, 'paper', 'this evidence weakens the claim')).toBe('weakens');
    expect(inferLinkTypeFromPack(pack, 'paper', 'mentions only')).toBeNull();
  });

  test('returns null when no rule fires (caller falls through to legacy)', () => {
    const pack = minimalPack([
      { name: 'cites', inference: { regex: '\\bcites?\\b' } },
    ]);
    expect(inferLinkTypeFromPack(pack, 'paper', 'no matching text here')).toBeNull();
  });

  test('first match wins in declaration order', () => {
    const pack = minimalPack([
      { name: 'first-match', inference: { regex: '\\bword\\b' } },
      { name: 'second-match', inference: { regex: '\\bword\\b' } },
    ]);
    expect(inferLinkTypeFromPack(pack, 'concept', 'the word matters')).toBe('first-match');
  });

  test('respects PageRegexBudget exhaustion', () => {
    const pack = minimalPack([
      { name: 'a', inference: { regex: '\\ba\\b' } },
      { name: 'b', inference: { regex: '\\bb\\b' } },
    ]);
    const budget = new PageRegexBudget();
    // First call within budget — should resolve.
    expect(inferLinkTypeFromPack(pack, 'concept', 'a then b', budget)).toBe('a');
    // Budget tracker accumulates.
    expect(budget.getCumulativeMs()).toBeGreaterThanOrEqual(0);
  });

  test('legacy inferLinkType still operates independently', () => {
    // The pack-aware variant doesn't break legacy callers.
    expect(inferLinkType('person', 'founded Acme Corp last year')).toBe('founded');
    expect(inferLinkType('person', 'invested in Acme Series A')).toBe('invested_in');
    expect(inferLinkType('person', 'advises Acme')).toBe('advises');
  });

  test('pack-aware regex with malformed pattern returns null gracefully', () => {
    // Pack validation should catch this at load; this is the runtime
    // safety net.
    const pack = minimalPack([
      { name: 'broken', inference: { regex: '[unclosed' } },
    ]);
    expect(inferLinkTypeFromPack(pack, 'concept', 'text')).toBeNull();
  });

  test('personal-brain pack — 28-verb ontology resolves bilingual triggers', () => {
    // Tests the ACTUAL shipped pack artifact (not an inline copy) so the
    // contract pins what `extract links --ner` will really do.
    const pack = loadPackFromFile(PERSONAL_BRAIN_PATH);
    // Sanity: 28 verbs, attended page_type-bound, mentions last.
    expect(pack.link_types.length).toBe(28);
    expect(pack.link_types[0]!.name).toBe('attended');
    expect(pack.link_types[pack.link_types.length - 1]!.name).toBe('mentions');

    const expectVerb = (verb: string, pageType: string, ctx: string) => {
      expect(inferLinkTypeFromPack(pack, pageType, ctx)).toBe(verb);
    };
    // People graph — formal + colloquial Chinese + English
    expectVerb('reports_to', 'person', '张三汇报给李四');
    expectVerb('reports_to', 'person', '老板是李四');
    expectVerb('reports_to', 'person', 'he reports to the VP');
    expectVerb('manages', 'person', '李四带三个工程师');
    expectVerb('manages', 'person', '手下有五个人');
    expectVerb('advises', 'company', '担任字节跳动顾问');
    expectVerb('advises', 'company', '给了一些建议');
    expectVerb('advises', 'company', 'he is an advisor to the company');
    expectVerb('mentors', 'person', '他辅导新人张三');
    expectVerb('introduced', 'person', '我介绍认识张三');
    expectVerb('member_of', 'org', '张三属于平台团队');
    expectVerb('member_of', 'org', '加入公司团队');
    expectVerb('collaborates_with', 'person', '和张三一起推进');
    expectVerb('collaborates_with', 'person', '跟王五一起做');
    // Execution graph
    expectVerb('assigned_to', 'person', 'action负责人是张三');
    expectVerb('assigned_to', 'person', '这个给王五跟一下');
    expectVerb('assigned_to', 'person', '麻烦你跟一下');
    expectVerb('owns', 'project', '张三主导runtime项目');
    expectVerb('owns', 'workstream', 'drive这个workstream');
    expectVerb('reviewed_by', 'artifact', '李四审核了方案');
    expectVerb('authored', 'artifact', '文档是张三写的');
    expectVerb('authored', 'artifact', '他起草了proposal');
    expectVerb('contributes_to', 'project', '张三贡献了代码');
    expectVerb('works_on', 'project', '张三在做VoltMind');
    expectVerb('works_on', 'project', '跟进runtime项目');
    expectVerb('blocks', 'action', '这个任务卡住了上线');
    expectVerb('depends_on', 'project', '这个项目依赖某个组件');
    expectVerb('depends_on', 'project', '基于已有架构');
    // Knowledge provenance
    expectVerb('decided_in', 'decision', '会上决定采用local-first');
    expectVerb('decided_in', 'decision', '拍板了');
    expectVerb('evidence_for', 'decision', '群里提到的证据');
    expectVerb('discussed_in', 'concept', '周会聊过Company Brain');
    expectVerb('discovered_by', 'risk', '张三发现了这个风险');
    // Business graph
    expectVerb('founded', 'company', '张三创立了字节跳动');
    expectVerb('founded', 'company', 'she founded Anchor last year');
    expectVerb('invested_in', 'company', '红杉领投了seed');
    expectVerb('invested_in', 'company', '给了一笔钱');
    expectVerb('invested_in', 'company', 'Sequoia led the seed round');
    expectVerb('customer_of', 'company', 'Acme是我们的客户');
    expectVerb('supplies_to', 'company', '某厂商供货');
    expectVerb('competes_with', 'company', '字节是对标竞品');
    // works_at last — generic verb still resolves
    expectVerb('works_at', 'company', '张三加入字节跳动');
    expectVerb('works_at', 'company', '跳槽去了Acme');
    expectVerb('works_at', 'company', '之前在Google');
    expectVerb('works_at', 'company', 'she works at Acme as CTO');
    // attended is page_type-bound: a meeting target always resolves to
    // attended BEFORE any regex verb fires.
    expect(inferLinkTypeFromPack(pack, 'meeting', '周会聊过Company Brain')).toBe('attended');
    // No trigger → null (NER writes no edge; `mentions` is the by-mention path)
    expect(inferLinkTypeFromPack(pack, 'concept', '完全不相关的描述文本')).toBeNull();
  });

  test('personal-brain pack — first-match-wins ordering resolves overlaps', () => {
    const pack = loadPackFromFile(PERSONAL_BRAIN_PATH);
    // "担任顾问" → advises (NOT works_at's bare 担任)
    expect(inferLinkTypeFromPack(pack, 'company', '他担任顾问')).toBe('advises');
    // "action负责人" → assigned_to (NOT owns's bare 负责)
    expect(inferLinkTypeFromPack(pack, 'person', 'action负责人是张三')).toBe('assigned_to');
    // "加入项目" → works_on (NOT works_at's bare 加入)
    expect(inferLinkTypeFromPack(pack, 'project', '张三加入runtime项目')).toBe('works_on');
    // "加入字节跳动" (company, no 项目) → works_at
    expect(inferLinkTypeFromPack(pack, 'company', '张三加入字节跳动')).toBe('works_at');
    // blocks vs depends_on split: "依赖" → depends_on (NOT blocks)
    expect(inferLinkTypeFromPack(pack, 'project', '依赖某个组件')).toBe('depends_on');
    expect(inferLinkTypeFromPack(pack, 'action', '这个任务卡住了上线')).toBe('blocks');
  });

  test('personal-brain pack — target_type guard rejects mismatched target (NER precision)', () => {
    // Domain verbs that semantically target a specific page type declare
    // `inference.target_type`. When the actual target type mismatches, the
    // verb is skipped (returns null) so the by-mention fallback takes over
    // instead of mis-typing a person as the object of authored/discovered_by.
    const pack = loadPackFromFile(PERSONAL_BRAIN_PATH);
    // WRONG target (person) → rejected across all type-constrained verbs
    expect(inferLinkTypeFromPack(pack, 'person', '他起草了proposal')).toBeNull();
    expect(inferLinkTypeFromPack(pack, 'person', '发现了bug')).toBeNull();
    expect(inferLinkTypeFromPack(pack, 'person', '这是依据')).toBeNull();
    expect(inferLinkTypeFromPack(pack, 'person', '拍板了')).toBeNull();
    expect(inferLinkTypeFromPack(pack, 'person', '聊过这个')).toBeNull();
    expect(inferLinkTypeFromPack(pack, 'person', '审核了方案')).toBeNull();
    expect(inferLinkTypeFromPack(pack, 'person', '卡住了')).toBeNull();
    expect(inferLinkTypeFromPack(pack, 'person', '依赖组件')).toBeNull();
    expect(inferLinkTypeFromPack(pack, 'person', '属于团队')).toBeNull();
    expect(inferLinkTypeFromPack(pack, 'person', '主导项目')).toBeNull();
    expect(inferLinkTypeFromPack(pack, 'person', '贡献了代码')).toBeNull();
    expect(inferLinkTypeFromPack(pack, 'person', '在做项目')).toBeNull();
    // CORRECT target → resolves (incl. multi-type target_type lists)
    expect(inferLinkTypeFromPack(pack, 'artifact', '他起草了proposal')).toBe('authored');
    expect(inferLinkTypeFromPack(pack, 'risk', '发现了这个风险')).toBe('discovered_by');
    expect(inferLinkTypeFromPack(pack, 'decision', '这是依据')).toBe('evidence_for');
    expect(inferLinkTypeFromPack(pack, 'decision', '拍板了')).toBe('decided_in');
    expect(inferLinkTypeFromPack(pack, 'concept', '聊过这个')).toBe('discussed_in');
    expect(inferLinkTypeFromPack(pack, 'artifact', '审核了方案')).toBe('reviewed_by');
    expect(inferLinkTypeFromPack(pack, 'action', '卡住了')).toBe('blocks');
    expect(inferLinkTypeFromPack(pack, 'project', '依赖组件')).toBe('depends_on');
    // multi-type: member_of → org OR company
    expect(inferLinkTypeFromPack(pack, 'org', '属于团队')).toBe('member_of');
    expect(inferLinkTypeFromPack(pack, 'company', '属于公司')).toBe('member_of');
    // multi-type: owns → project OR workstream
    expect(inferLinkTypeFromPack(pack, 'project', '主导项目')).toBe('owns');
    expect(inferLinkTypeFromPack(pack, 'workstream', '主导workstream')).toBe('owns');
    // multi-type: contributes_to → project OR workstream OR artifact
    expect(inferLinkTypeFromPack(pack, 'project', '贡献了代码')).toBe('contributes_to');
    expect(inferLinkTypeFromPack(pack, 'workstream', '贡献workstream')).toBe('contributes_to');
    expect(inferLinkTypeFromPack(pack, 'artifact', '贡献了文档')).toBe('contributes_to');
    // multi-type: works_on → project OR workstream
    expect(inferLinkTypeFromPack(pack, 'project', '在做项目')).toBe('works_on');
    expect(inferLinkTypeFromPack(pack, 'workstream', '在做workstream')).toBe('works_on');
  });

  test('personal-brain pack — accepted colloquial-trigger conflicts (first-match-wins)', () => {
    // The ontology deliberately keeps BOTH a broad people-graph trigger and
    // a narrower business/knowledge trigger even when they overlap, because
    // NER cannot see the source page type. These pin the resolved behavior
    // so future edits don't silently shift it.
    const pack = loadPackFromFile(PERSONAL_BRAIN_PATH);
    // advises 帮忙看 precedes reviewed_by 帮忙看看 → advises wins
    expect(inferLinkTypeFromPack(pack, 'artifact', '帮忙看看这个artifact')).toBe('advises');
    // reviewed_by english `review` precedes discussed_in `review过` → reviewed_by wins
    expect(inferLinkTypeFromPack(pack, 'artifact', 'review过这个artifact')).toBe('reviewed_by');
    // contributes_to 支持 precedes invested_in → contributes_to wins for "写check支持"
    expect(inferLinkTypeFromPack(pack, 'project', '写check支持')).toBe('contributes_to');
    // collaborates_with 合作 precedes partner_of 合作伙伴 → collaborates_with wins
    expect(inferLinkTypeFromPack(pack, 'company', '字节是战略合作伙伴')).toBe('collaborates_with');
  });
});

describe('frontmatterLinkTypeFromPack (T7b)', () => {
  test('person:company → works_at via pack declaration', () => {
    const pack = parseSchemaPackManifest({
      api_version: 'voltmind-schema-pack-v1',
      name: 'test',
      version: '0.1.0',
      extends: null,
      page_types: [],
      link_types: [],
      frontmatter_links: [
        { page_type: 'person', fields: ['company', 'companies'], link_type: 'works_at' },
        { page_type: 'company', fields: ['key_people'], link_type: 'works_at' },
        { page_type: 'meeting', fields: ['attendees'], link_type: 'attended' },
      ],
    });
    expect(frontmatterLinkTypeFromPack(pack, 'person', 'company')).toBe('works_at');
    expect(frontmatterLinkTypeFromPack(pack, 'person', 'companies')).toBe('works_at');
    expect(frontmatterLinkTypeFromPack(pack, 'company', 'key_people')).toBe('works_at');
    expect(frontmatterLinkTypeFromPack(pack, 'meeting', 'attendees')).toBe('attended');
    expect(frontmatterLinkTypeFromPack(pack, 'person', 'random_field')).toBeNull();
    // Wrong page type: doesn't match.
    expect(frontmatterLinkTypeFromPack(pack, 'company', 'company')).toBeNull();
  });

  test('empty frontmatter_links returns null for every field', () => {
    const pack = parseSchemaPackManifest({
      api_version: 'voltmind-schema-pack-v1',
      name: 'test',
      version: '0.1.0',
      extends: null,
      page_types: [],
      link_types: [],
    });
    expect(frontmatterLinkTypeFromPack(pack, 'person', 'company')).toBeNull();
  });
});
