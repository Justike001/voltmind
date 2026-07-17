/**
 * An unavailable optional proposal provider must be represented as a clean
 * skip, never as one repeated warning for each page in a maintenance cycle.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(import.meta.dir, '..', 'src', 'core', 'cycle.ts'), 'utf8');

describe('cycle propose_takes provider gate', () => {
  test('checks the configured Anthropic key before dispatching the page scanner', () => {
    const blockStart = source.indexOf("if (phases.includes('propose_takes'))");
    const block = source.slice(blockStart, blockStart + 2200);
    expect(block).toContain("await engine.getConfig('anthropic_api_key')");
    expect(block).toContain("reason: 'provider_not_configured'");
    expect(block.indexOf("reason: 'provider_not_configured'")).toBeLessThan(
      block.indexOf('runPhaseProposeTakes'),
    );
  });
});
