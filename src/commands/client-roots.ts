import { existsSync } from 'node:fs';
import { loadConfigFileOnly, saveConfig, type VoltMindConfig } from '../core/config.ts';
import {
  normalizeClientRootKey,
  normalizeClientRootPath,
  normalizeLocalFilePath,
  resolveLogicalFilePath,
} from '../core/client-file-roots.ts';

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): void {
  console.log(`Usage:
  voltmind client-roots list [--json]
  voltmind client-roots add <root-key> [--local-root <Z:\\>] [--unc-root <\\\\server\\share>]
  voltmind client-roots remove <root-key>
  voltmind client-roots test <root-key>
  voltmind client-roots normalize <absolute-path>
  voltmind client-roots resolve <root-key> <relative-path>`);
}

function fileConfig(): VoltMindConfig {
  return loadConfigFileOnly() ?? { engine: 'pglite' };
}

export async function runClientRoots(args: string[]): Promise<void> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }
  const command = args[0];
  const config = fileConfig();
  config.client_file_roots ??= {};

  if (command === 'list') {
    if (args.includes('--json')) {
      console.log(JSON.stringify(config.client_file_roots));
      return;
    }
    const entries = Object.entries(config.client_file_roots);
    if (entries.length === 0) {
      console.log('No client file roots configured.');
      return;
    }
    for (const [key, mapping] of entries) {
      console.log(`${key}\tlocal=${mapping.local_root ?? '-'}\tunc=${mapping.unc_root ?? '-'}`);
    }
    return;
  }

  if (command === 'add') {
    const key = normalizeClientRootKey(args[1] ?? '');
    const local = valueAfter(args, '--local-root');
    const unc = valueAfter(args, '--unc-root');
    if (!local && !unc) throw new Error('add requires --local-root and/or --unc-root');
    config.client_file_roots[key] = {
      ...(local ? { local_root: normalizeClientRootPath(local, 'local') } : {}),
      ...(unc ? { unc_root: normalizeClientRootPath(unc, 'unc') } : {}),
    };
    saveConfig(config);
    console.log(`Configured client file root '${key}'.`);
    return;
  }

  if (command === 'remove') {
    const key = normalizeClientRootKey(args[1] ?? '');
    if (!config.client_file_roots[key]) throw new Error(`client file root '${key}' is not configured`);
    delete config.client_file_roots[key];
    saveConfig(config);
    console.log(`Removed client file root '${key}'.`);
    return;
  }

  if (command === 'test') {
    const key = normalizeClientRootKey(args[1] ?? '');
    const mapping = config.client_file_roots[key];
    if (!mapping) throw new Error(`client file root '${key}' is not configured`);
    const checks = [
      ...(mapping.local_root ? [{ kind: 'local', path: mapping.local_root }] : []),
      ...(mapping.unc_root ? [{ kind: 'unc', path: mapping.unc_root }] : []),
    ];
    for (const check of checks) console.log(`${check.kind}\t${existsSync(check.path) ? 'accessible' : 'unavailable'}\t${check.path}`);
    if (!checks.some(check => existsSync(check.path))) process.exitCode = 2;
    return;
  }

  if (command === 'normalize') {
    const input = args.slice(1).join(' ');
    console.log(JSON.stringify(normalizeLocalFilePath(config, input), null, 2));
    return;
  }

  if (command === 'resolve') {
    const key = args[1] ?? '';
    const relative = args.slice(2).join(' ');
    console.log(resolveLogicalFilePath(config, key, relative));
    return;
  }

  usage();
  throw new Error(`unknown client-roots command '${command}'`);
}
