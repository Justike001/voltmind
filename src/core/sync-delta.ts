/**
 * Shared sync-delta machinery.
 *
 * This is the single implementation of "what changed since last_commit" for
 * sync execution and cost estimation. It is shell-injection safe because git
 * is invoked with execFileSync array args, never through a shell.
 */

import { execFileSync } from 'node:child_process';
import { buildSyncManifest, type SyncManifest } from './sync.ts';

export type GitRunner = (repoPath: string, args: string[]) => string;

const DEFAULT_GIT_RUNNER: GitRunner = (repoPath, args) =>
  execFileSync('git', ['-c', 'core.quotepath=false', '-C', repoPath, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
    maxBuffer: 100 * 1024 * 1024,
  }).trim();

let gitRunner: GitRunner = DEFAULT_GIT_RUNNER;

export function _setGitRunnerForTests(fn: GitRunner | null): void {
  gitRunner = fn ?? DEFAULT_GIT_RUNNER;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function buildDetachedWorkingTreeManifest(
  repoPath: string,
  run: GitRunner = gitRunner,
): SyncManifest {
  const manifest = buildSyncManifest(run(repoPath, ['diff', '--name-status', '-M', 'HEAD']));
  const untracked = run(repoPath, ['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(line => line.length > 0);
  return {
    added: unique([...manifest.added, ...untracked]),
    modified: unique(manifest.modified),
    deleted: unique(manifest.deleted),
    renamed: manifest.renamed,
  };
}

export type SyncDeltaResult =
  | { status: 'ok'; manifest: SyncManifest }
  | { status: 'unavailable'; reason: 'anchor_missing' | 'diff_failed' };

export interface ComputeSyncDeltaOpts {
  detachedManifest?: SyncManifest | null;
  detached?: boolean;
}

export function computeSyncDelta(
  repoPath: string,
  fromCommit: string,
  toCommit: string,
  opts: ComputeSyncDeltaOpts = {},
): SyncDeltaResult {
  const run = gitRunner;

  try {
    run(repoPath, ['cat-file', '-t', fromCommit]);
  } catch {
    return { status: 'unavailable', reason: 'anchor_missing' };
  }

  let diffOutput: string;
  try {
    diffOutput = run(repoPath, ['diff', '--name-status', '-M', `${fromCommit}..${toCommit}`]);
  } catch {
    return { status: 'unavailable', reason: 'diff_failed' };
  }

  const manifest = buildSyncManifest(diffOutput);
  const detached =
    opts.detachedManifest !== undefined && opts.detachedManifest !== null
      ? opts.detachedManifest
      : opts.detached
        ? buildDetachedWorkingTreeManifest(repoPath, run)
        : null;

  if (detached) {
    manifest.added = unique([...manifest.added, ...detached.added]);
    manifest.modified = unique([...manifest.modified, ...detached.modified]);
    manifest.deleted = unique([...manifest.deleted, ...detached.deleted]);
    manifest.renamed = [...manifest.renamed, ...detached.renamed];
  }

  return { status: 'ok', manifest };
}
