import type { VoltMindConfig } from './config.ts';

export interface ClientFileRoot {
  local_root?: string;
  unc_root?: string;
}

export interface LogicalFilePath {
  root_key: string;
  relative_path: string;
}

const ROOT_KEY_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function normalizeClientRootKey(value: string): string {
  const key = value.trim().toLowerCase();
  if (!ROOT_KEY_RE.test(key)) {
    throw new Error('root key must use lowercase letters, digits, dot, underscore, or hyphen');
  }
  return key;
}

function stripTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/g, '');
}

export function normalizeClientRootPath(value: string, kind: 'local' | 'unc'): string {
  const root = value.trim();
  if (kind === 'local' && !/^[a-z]:[\\/]/i.test(root)) {
    throw new Error('local root must be an absolute Windows drive path');
  }
  if (kind === 'unc' && !/^\\\\[^\\]+\\[^\\]+(?:[\\/]|$)/.test(root)) {
    throw new Error('UNC root must start with \\\\server\\share');
  }
  if (/[\r\n\0]/.test(root)) throw new Error('file root must not contain control characters');
  const stripped = stripTrailingSeparators(root);
  return kind === 'local' && /^[a-z]:$/i.test(stripped) ? `${stripped}\\` : stripped;
}

export function normalizeRelativeFilePath(value: string): string {
  const raw = value.trim().replace(/\\/g, '/');
  if (!raw || /^[a-z]:/i.test(raw) || raw.startsWith('//')) {
    throw new Error('relative path must not contain a drive letter or UNC host');
  }
  const segments = raw.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some(segment => segment === '.' || segment === '..')) {
    throw new Error('relative path must not contain traversal segments');
  }
  if (segments.some(segment => /[\r\n\0]/.test(segment))) {
    throw new Error('relative path must not contain control characters');
  }
  return segments.join('/');
}

function configuredRoots(config: VoltMindConfig | null): Array<{
  root_key: string;
  root: string;
}> {
  const rows: Array<{ root_key: string; root: string }> = [];
  for (const [rawKey, mapping] of Object.entries(config?.client_file_roots ?? {})) {
    const root_key = normalizeClientRootKey(rawKey);
    if (mapping.local_root) rows.push({ root_key, root: normalizeClientRootPath(mapping.local_root, 'local') });
    if (mapping.unc_root) rows.push({ root_key, root: normalizeClientRootPath(mapping.unc_root, 'unc') });
  }
  return rows.sort((a, b) => b.root.length - a.root.length);
}

/** Convert a workstation-specific drive/UNC path into a server-safe locator. */
export function normalizeLocalFilePath(config: VoltMindConfig | null, input: string): LogicalFilePath {
  const candidate = input.trim().replace(/[.,;]+$/g, '');
  for (const mapping of configuredRoots(config)) {
    const root = stripTrailingSeparators(mapping.root);
    const lowerCandidate = candidate.toLowerCase();
    const lowerRoot = root.toLowerCase();
    const exact = lowerCandidate === lowerRoot;
    const below = lowerCandidate.startsWith(`${lowerRoot}\\`) || lowerCandidate.startsWith(`${lowerRoot}/`);
    if (!exact && !below) continue;
    const remainder = candidate.slice(root.length).replace(/^[\\/]+/, '');
    if (!remainder) throw new Error('path points at a configured root, not a file below it');
    return {
      root_key: mapping.root_key,
      relative_path: normalizeRelativeFilePath(remainder),
    };
  }
  throw new Error('path does not match any configured client file root');
}

/** Resolve a server-safe locator to this workstation's preferred open path. */
export function resolveLogicalFilePath(
  config: VoltMindConfig | null,
  rootKey: string,
  relativePath: string,
): string {
  const key = normalizeClientRootKey(rootKey);
  const mapping = config?.client_file_roots?.[key];
  if (!mapping) throw new Error(`client file root '${key}' is not configured`);
  const root = mapping.local_root
    ? normalizeClientRootPath(mapping.local_root, 'local')
    : mapping.unc_root
      ? normalizeClientRootPath(mapping.unc_root, 'unc')
      : null;
  if (!root) throw new Error(`client file root '${key}' has no local_root or unc_root`);
  const relative = normalizeRelativeFilePath(relativePath);
  const separator = root.includes('\\') || /^[a-z]:/i.test(root) ? '\\' : '/';
  return `${stripTrailingSeparators(root)}${separator}${relative.replace(/\//g, separator)}`;
}

export function decorateFileRefWithClientPath<T extends Record<string, unknown>>(
  config: VoltMindConfig | null,
  ref: T,
): T & { resolved_open_path?: string; resolution_status: 'resolved' | 'unconfigured_root' | 'not_filesystem' } {
  if (ref.provider !== 'filesystem' || typeof ref.root_key !== 'string' || typeof ref.relative_path !== 'string') {
    return { ...ref, resolution_status: 'not_filesystem' };
  }
  try {
    return {
      ...ref,
      resolved_open_path: resolveLogicalFilePath(config, ref.root_key, ref.relative_path),
      resolution_status: 'resolved',
    };
  } catch {
    return { ...ref, resolution_status: 'unconfigured_root' };
  }
}
