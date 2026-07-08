import { existsSync, realpathSync, type Stats } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'path';

export function realpathOrResolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolvePath(p);
  }
}

export function isPathContained(child: string, parent: string): boolean {
  const resolvedChild = realpathOrResolve(child);
  const resolvedParent = realpathOrResolve(parent);
  const rel = relative(resolvedParent, resolvedChild);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function isTrustedDotfile(stats: Stats): boolean {
  if (typeof process.getuid !== 'function') return true;
  if (stats.isSymbolicLink()) return false;
  const myUid = process.getuid();
  if (stats.uid !== myUid && stats.uid !== 0) return false;
  if ((stats.mode & 0o002) !== 0) return false;
  return true;
}

export function isWriteTargetContained(target: string, root: string): boolean {
  const resolvedRoot = realpathOrResolve(root);
  let existing = resolvePath(target);
  const tail: string[] = [];
  for (let i = 0; i < 4096 && !existsSync(existing); i++) {
    tail.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const base = realpathOrResolve(existing);
  const finalPath = tail.length ? join(base, ...tail) : base;
  const rel = relative(resolvedRoot, finalPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
