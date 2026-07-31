import { describe, expect, test } from 'bun:test';
import type { VoltMindConfig } from '../src/core/config.ts';
import {
  decorateFileRefWithClientPath,
  normalizeLocalFilePath,
  resolveLogicalFilePath,
} from '../src/core/client-file-roots.ts';

const config = {
  engine: 'postgres',
  client_file_roots: {
    'synology-public': {
      local_root: 'Z:\\',
      unc_root: '\\\\RaiDrive-JustikeLiu\\Synology',
    },
  },
} satisfies VoltMindConfig;

describe('client file root resolver', () => {
  test('normalizes drive and user-specific UNC paths to one logical locator', () => {
    expect(normalizeLocalFilePath(config, 'Z:\\Public\\Finance\\Plan.xlsx')).toEqual({
      root_key: 'synology-public',
      relative_path: 'Public/Finance/Plan.xlsx',
    });
    expect(normalizeLocalFilePath(config, '\\\\RaiDrive-JustikeLiu\\Synology\\Public\\Finance\\Plan.xlsx')).toEqual({
      root_key: 'synology-public',
      relative_path: 'Public/Finance/Plan.xlsx',
    });
  });

  test('resolves a logical locator using the current workstation mapping', () => {
    expect(resolveLogicalFilePath(config, 'synology-public', 'Public/Finance/Plan.xlsx'))
      .toBe('Z:\\Public\\Finance\\Plan.xlsx');
  });

  test('rejects traversal and unknown roots', () => {
    expect(() => resolveLogicalFilePath(config, 'synology-public', '../secret.txt')).toThrow(/traversal/);
    expect(() => resolveLogicalFilePath(config, 'unknown-root', 'Public/a.txt')).toThrow(/not configured/);
  });

  test('decorates server results without mutating canonical identity', () => {
    const result = decorateFileRefWithClientPath(config, {
      provider: 'filesystem',
      root_key: 'synology-public',
      relative_path: 'Public/a.txt',
    });
    expect(result.resolution_status).toBe('resolved');
    expect(result.resolved_open_path).toBe('Z:\\Public\\a.txt');
  });
});
