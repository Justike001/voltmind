import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

describe('process stdout/stderr log tee', () => {
  test('captures stdout and stderr while preserving native process output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voltmind-process-log-'));
    const logPath = join(dir, 'runtime.log');
    try {
      const script = [
        `import { installProcessLog } from ${JSON.stringify(join(process.cwd(), 'src/core/process-log.ts'))};`,
        `installProcessLog(${JSON.stringify(logPath)});`,
        `process.stdout.write('stdout-line\\n');`,
        `process.stderr.write('stderr-line\\n');`,
      ].join('\n');
      const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('stdout-line');
      expect(result.stderr).toContain('stderr-line');
      const log = readFileSync(logPath, 'utf8');
      expect(log).toContain('stdout-line');
      expect(log).toContain('stderr-line');
      expect(log).toContain('[process-log] attached');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
