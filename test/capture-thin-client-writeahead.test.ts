import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('thin-client capture write-ahead', () => {
  test('remote failure retains the local page and pending receipt', async () => {
    root = mkdtempSync(join(tmpdir(), 'voltmind-thin-capture-'));
    const vault = join(root, 'vault');
    const home = join(root, '.voltmind');
    mkdirSync(vault, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      engine: 'postgres',
      schema_pack: 'voltmind-personal-brain',
      client_vault_path: vault,
      remote_mcp: {
        issuer_url: 'https://127.0.0.1:1',
        mcp_url: 'https://127.0.0.1:1/mcp',
        oauth_client_id: 'fixture-client',
        oauth_client_secret: 'fixture-secret',
      },
    }));

    const proc = Bun.spawn(
      ['bun', 'run', 'src/cli.ts', 'capture', '--slug', 'inbox/writeahead', 'durable before remote'],
      {
        cwd: join(import.meta.dir, '..'),
        env: { ...process.env, VOLTMIND_HOME: root },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('local_written_remote_pending');
    expect(readFileSync(join(vault, 'inbox', 'writeahead.md'), 'utf8'))
      .toContain('durable before remote');
    const receiptsDir = join(vault, '.voltmind', 'pending-remote');
    const receipts = readdirSync(receiptsDir);
    expect(receipts).toHaveLength(1);
    const receipt = JSON.parse(readFileSync(join(receiptsDir, receipts[0]), 'utf8'));
    expect(receipt.status).toBe('local_written_remote_pending');
    expect(receipt.slug).toBe('inbox/writeahead');
  });
});
