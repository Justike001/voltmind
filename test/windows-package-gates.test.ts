import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

describe('Windows package gates', () => {
  test('shell-script checks invoke bash explicitly', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const [name, command] of Object.entries(pkg.scripts)) {
      if (!name.startsWith('check:') || !command.includes('.sh')) continue;
      const shellSegments = command.split('&&').map(segment => segment.trim()).filter(segment => segment.includes('.sh'));
      for (const segment of shellSegments) {
        expect(segment, `${name}: ${segment}`).toMatch(/^bash\s+scripts\//);
      }
    }
  });
});
