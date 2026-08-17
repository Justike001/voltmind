/**
 * Client-first semantic page writer.
 *
 * This is the write-ahead half of the client-first contract:
 *   validate canonical Markdown -> persist local vault -> remote MCP put_page.
 *
 * The remote call is intentionally owned by the caller so a network failure
 * cannot roll back or hide the authoritative local write.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { VoltMindConfig } from './config.ts';
import { createFrontmatterBackup } from './brain-writer.ts';
import { CJK_SLUG_CHARS } from './cjk.ts';
import { validateCanonicalPageTemplate } from './page-template-contract.ts';
import { loadActivePack } from './schema-pack/load-active.ts';

export interface ClientFirstLocalWriteReceipt {
  status: 'local_written_remote_pending';
  slug: string;
  path: string;
  content_sha256: string;
  bytes: number;
  template_type?: string;
  template_section?: string;
  backup_path?: string;
  /** Durable client-local synchronization ledger entry. */
  receipt_path: string;
}

interface ClientFirstSyncReceiptFile extends Omit<ClientFirstLocalWriteReceipt, 'status'> {
  schema_version: 1;
  created_at: string;
  updated_at: string;
  attempts: number;
  status: 'local_written_remote_pending' | 'synchronized';
  synchronized_at?: string;
}

export class ClientFirstPageWriteError extends Error {
  constructor(
    public readonly code:
      | 'client_vault_not_configured'
      | 'client_vault_not_found'
      | 'invalid_page_slug'
      | 'path_outside_client_vault'
      | 'template_contract_violation'
      | 'template_contract_unavailable'
      | 'local_write_verification_failed',
    message: string,
    public readonly suggestion?: string,
  ) {
    super(message);
    this.name = 'ClientFirstPageWriteError';
  }
}

export function resolveClientVaultPath(
  config: VoltMindConfig,
  override?: string,
): string {
  const configured = (
    override
    ?? process.env.VOLTMIND_CLIENT_VAULT_PATH
    ?? config.client_vault_path
    ?? ''
  ).trim();
  if (!configured) {
    throw new ClientFirstPageWriteError(
      'client_vault_not_configured',
      'Client-first put_page requires a local vault before remote synchronization.',
      'Run `voltmind init --mcp-only --vault-path <path> --force` or set VOLTMIND_CLIENT_VAULT_PATH.',
    );
  }
  const vaultPath = resolve(configured);
  if (!existsSync(vaultPath) || !statSync(vaultPath).isDirectory()) {
    throw new ClientFirstPageWriteError(
      'client_vault_not_found',
      `Configured client vault is not an accessible directory: ${vaultPath}`,
      'Create/checkout the vault locally, then retry the same page write.',
    );
  }
  return vaultPath;
}

export async function writeClientFirstPage(
  config: VoltMindConfig,
  input: { slug: string; content: string; vaultPath?: string },
): Promise<ClientFirstLocalWriteReceipt> {
  validateClientPageSlug(input.slug);
  const vaultPath = resolveClientVaultPath(config, input.vaultPath);

  let activePack: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> };
  try {
    const resolvedPack = await loadActivePack({ cfg: config, remote: false });
    activePack = { page_types: resolvedPack.manifest.page_types };
  } catch (error) {
    throw new ClientFirstPageWriteError(
      'template_contract_unavailable',
      `Cannot load the client schema pack before local write: ${error instanceof Error ? error.message : String(error)}`,
      'Install/configure the active schema pack locally before retrying.',
    );
  }

  let validation;
  try {
    validation = validateCanonicalPageTemplate(input.slug, input.content, activePack);
  } catch (error) {
    throw new ClientFirstPageWriteError(
      'template_contract_unavailable',
      `Cannot load the canonical page template before local write: ${error instanceof Error ? error.message : String(error)}`,
      'Set VOLTMIND_PAGE_TEMPLATE_DRAFT or reinstall VoltMind so the canonical draft is bundled.',
    );
  }
  if (validation && validation.findings.length > 0) {
    const summary = validation.findings.slice(0, 12).map((finding) => finding.message).join('; ');
    throw new ClientFirstPageWriteError(
      'template_contract_violation',
      `Local page rejected before vault write (${validation.type}/${validation.section}): ${summary}`,
      `Rewrite the page using ${validation.draftPath} and retry. No local or remote write occurred.`,
    );
  }

  const targetPath = resolve(vaultPath, ...input.slug.split('/')) + '.md';
  const rel = relative(vaultPath, targetPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new ClientFirstPageWriteError(
      'path_outside_client_vault',
      `Resolved page target is outside the configured client vault: ${targetPath}`,
    );
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  const backupPath = existsSync(targetPath)
    ? createFrontmatterBackup(targetPath, { sourcePath: vaultPath })
    : undefined;
  const tempPath = join(
    dirname(targetPath),
    `.${input.slug.split('/').at(-1)}.md.tmp.${process.pid}.${randomBytes(4).toString('hex')}`,
  );
  try {
    writeFileSync(tempPath, input.content, { encoding: 'utf8' });
    renameSync(tempPath, targetPath);
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }

  const persisted = readFileSync(targetPath, 'utf8');
  if (persisted !== input.content) {
    throw new ClientFirstPageWriteError(
      'local_write_verification_failed',
      `Local page bytes differ after write: ${targetPath}`,
      'Do not call remote put_page; inspect the local filesystem and retry.',
    );
  }

  const receiptPath = clientFirstReceiptPath(vaultPath, input.slug);
  const now = new Date().toISOString();
  let priorReceipt: Partial<ClientFirstSyncReceiptFile> = {};
  try {
    priorReceipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Partial<ClientFirstSyncReceiptFile>;
  } catch {
    // First attempt or corrupt prior ledger: start a fresh durable receipt.
  }
  const receipt: ClientFirstLocalWriteReceipt = {
    status: 'local_written_remote_pending',
    slug: input.slug,
    path: targetPath,
    content_sha256: createHash('sha256').update(input.content, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(input.content, 'utf8'),
    ...(validation ? { template_type: validation.type, template_section: validation.section } : {}),
    ...(backupPath ? { backup_path: backupPath } : {}),
    receipt_path: receiptPath,
  };
  atomicWriteJson(receiptPath, {
    schema_version: 1,
    ...receipt,
    created_at: priorReceipt.created_at ?? now,
    updated_at: now,
    attempts: typeof priorReceipt.attempts === 'number' ? priorReceipt.attempts + 1 : 1,
  } satisfies ClientFirstSyncReceiptFile);
  return receipt;
}

/**
 * Mark a durable client-first receipt synchronized only after remote MCP
 * accepts the exact page. A crash/network failure before this call leaves the
 * receipt in local_written_remote_pending for an idempotent retry.
 */
export function markClientFirstPageSynchronized(receipt: ClientFirstLocalWriteReceipt): void {
  const now = new Date().toISOString();
  let existing: Partial<ClientFirstSyncReceiptFile> = {};
  try {
    existing = JSON.parse(readFileSync(receipt.receipt_path, 'utf8')) as Partial<ClientFirstSyncReceiptFile>;
  } catch {
    // Reconstruct from the in-memory receipt if the ledger was lost/corrupt.
  }
  atomicWriteJson(receipt.receipt_path, {
    schema_version: 1,
    ...receipt,
    ...existing,
    status: 'synchronized',
    created_at: existing.created_at ?? now,
    updated_at: now,
    attempts: typeof existing.attempts === 'number' ? existing.attempts : 1,
    synchronized_at: now,
  } satisfies ClientFirstSyncReceiptFile);
}

function clientFirstReceiptPath(vaultPath: string, slug: string): string {
  const key = createHash('sha256').update(slug, 'utf8').digest('hex');
  return join(vaultPath, '.voltmind', 'pending-remote', `${key}.json`);
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
}

function validateClientPageSlug(slug: string): void {
  if (typeof slug !== 'string' || slug.length === 0 || slug.length > 255) {
    throw new ClientFirstPageWriteError('invalid_page_slug', 'Page slug must contain 1-255 characters.');
  }
  const segment = `[a-z0-9${CJK_SLUG_CHARS}][a-z0-9${CJK_SLUG_CHARS}\\-]*`;
  if (!new RegExp(`^${segment}(\\/${segment})*$`, 'i').test(slug)) {
    throw new ClientFirstPageWriteError(
      'invalid_page_slug',
      `Invalid page slug '${slug}'. Use alphanumeric/CJK/hyphen segments separated by forward slashes.`,
    );
  }
}
