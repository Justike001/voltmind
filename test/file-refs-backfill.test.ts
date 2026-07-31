import { describe, expect, test } from 'bun:test';
import { backfillFileRefs } from '../src/commands/file-refs.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function previewEngine(compiledTruth: string): BrainEngine {
  return {
    async executeRaw() {
      return [{
        id: 1,
        source_id: 'default',
        slug: 'people/example-person',
        type: 'person',
        title: 'Example Person',
        compiled_truth: compiledTruth,
        timeline: '',
        frontmatter: {},
      }];
    },
  } as unknown as BrainEngine;
}

describe('file reference backfill preview', () => {
  test('does not consume a closing Markdown backtick and following prose as a duplicate path', async () => {
    const report = await backfillFileRefs(
      previewEngine('Paths: `Z:\\Public\\Projects\\Moss-Windy Lane` and `LPL-Bacon`.'),
      {
        dryRun: true,
        json: true,
        sourceId: 'default',
        rootKey: 'synology-public',
        localRoot: 'Z:\\',
        uncShare: 'Synology',
      },
    );

    expect(report.refs_found).toBe(1);
    expect(report.unresolved_path_refs).toBe(1);
    expect(report.candidates).toEqual([{
      page_slug: 'people/example-person',
      provider: 'filesystem',
      service: 'raidrive',
      name: 'Moss-Windy Lane',
      availability: 'unverified',
      display_path: 'Public/Projects/Moss-Windy Lane',
      root_key: 'synology-public',
      relative_path: 'Public/Projects/Moss-Windy Lane',
    }]);
    expect(JSON.stringify(report)).not.toContain('Z:\\');
  });

  test('returns credential-free Microsoft preview details', async () => {
    const report = await backfillFileRefs(
      previewEngine('[Plan](https://tenant.sharepoint.com/sites/demo/Shared%20Documents/Plan.xlsx)'),
      { dryRun: true, json: true, sourceId: 'default' },
    );

    expect(report.candidates).toEqual([{
      page_slug: 'people/example-person',
      provider: 'microsoft',
      service: 'sharepoint',
      name: 'Plan',
      availability: 'unverified',
      display_path: '/sites/demo/Shared Documents/Plan.xlsx',
    }]);
    expect(JSON.stringify(report.candidates)).not.toContain('https://');
    expect(JSON.stringify(report.candidates)).not.toContain('tenant_id');
  });
});
