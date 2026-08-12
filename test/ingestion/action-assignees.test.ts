import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  resolveStructuredAssigneesFromKnownEntities,
  validateActionAssigneeCoverage,
} from '../../src/core/ingestion/action-assignees.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

beforeEach(async () => {
  await resetPgliteState(engine);
}, 30_000);

describe('structured action assignees', () => {
  test('preserves adjacent Teams mentions as two structured assignees', () => {
    const assignees = resolveStructuredAssigneesFromKnownEntities(
      'Please ask Alice ExampleBob Example to collect sample images.',
      [
        { slug: 'people/alice-example', display_name: 'Alice Example' },
        { slug: 'people/bob-example', display_name: 'Bob Example' },
      ],
    );

    expect(assignees).toEqual([
      { slug: 'people/alice-example', display_name: 'Alice Example', source_text: 'Alice Example' },
      { slug: 'people/bob-example', display_name: 'Bob Example', source_text: 'Bob Example' },
    ]);
  });

  test('requires every assignee in frontmatter, body links, and person backlinks', async () => {
    const actionSlug = 'state/actions/collect-samples';
    await engine.putPage(actionSlug, {
      type: 'action',
      title: 'Collect samples',
      compiled_truth: 'Work with [[people/alice-example|Alice Example]] and [[people/bob-example|Bob Example]].',
      timeline: '',
      frontmatter: { related_people: ['people/alice-example', 'people/bob-example'] },
    }, { sourceId: 'default' });
    for (const slug of ['people/alice-example', 'people/bob-example']) {
      await engine.putPage(slug, {
        type: 'person',
        title: slug,
        compiled_truth: `Assigned through [[${actionSlug}]].`,
        timeline: '',
        frontmatter: {},
      }, { sourceId: 'default' });
    }

    const findings = await validateActionAssigneeCoverage(engine, 'default', [actionSlug], [{
      action_slug: actionSlug,
      assignees: [
        { slug: 'people/alice-example', display_name: 'Alice Example', source_text: 'Alice Example' },
        { slug: 'people/bob-example', display_name: 'Bob Example', source_text: 'Bob Example' },
      ],
    }]);
    expect(findings).toEqual([]);
  });

  test('reports every omitted deterministic projection surface', async () => {
    const actionSlug = 'state/actions/collect-samples';
    await engine.putPage(actionSlug, {
      type: 'action',
      title: 'Collect samples',
      compiled_truth: 'Two participants should collect samples.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' });
    await engine.putPage('people/alice-example', {
      type: 'person', title: 'Alice Example', compiled_truth: 'No action backlink.', timeline: '', frontmatter: {},
    }, { sourceId: 'default' });

    const findings = await validateActionAssigneeCoverage(engine, 'default', [actionSlug], [{
      action_slug: actionSlug,
      assignees: [{ slug: 'people/alice-example', display_name: 'Alice Example', source_text: 'Alice Example' }],
    }]);
    expect(new Set(findings.map(finding => finding.code))).toEqual(new Set([
      'ASSIGNEE_NOT_IN_FRONTMATTER',
      'ASSIGNEE_NOT_LINKED_IN_BODY',
      'ASSIGNEE_BACKLINK_MISSING',
    ]));
  });
});
