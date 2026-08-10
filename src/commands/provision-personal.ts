#!/usr/bin/env bun
/**
 * voltmind provision-personal — one-command personal-knowledge-base bootstrap
 * for the Host operator / Host agent.
 *
 *   voltmind provision-personal alice-example@company.example \
 *     --repo-url https://.../example-org/alice-example-notes.git
 *
 * Derives the personal source id from the company email, checks out the
 * optional knowledge repo, and mints a source-scoped OAuth client (the
 * thin-client credential). One email always maps to one source (dedup).
 *
 * DB route is CLI-local and trusted — never expose to an untrusted client.
 */

import { loadConfig, toEngineConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';
import type { BrainEngine } from '../core/engine.ts';
import { sqlQueryForEngine, type SqlQuery } from '../core/sql-query.ts';
import {
  deriveSourceIdFromEmail,
  normalizeCompanyEmail,
  provisionPersonalSource,
} from '../core/personal-provision.ts';

async function withConfiguredSql<T>(
  fn: (sql: SqlQuery, engine: BrainEngine) => Promise<T>,
): Promise<T> {
  const config = loadConfig();
  if (!config) {
    console.error('No VoltMind config found. Run `voltmind init` first.');
    process.exit(1);
  }
  const engineConfig = toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  const sql = sqlQueryForEngine(engine);
  try {
    return await fn(sql, engine);
  } finally {
    await engine.disconnect();
  }
}

export async function runProvisionPersonal(args: string[]): Promise<void> {
  const emailArg = args.find(a => !a.startsWith('--'));
  if (!emailArg) {
    console.error(
      'Usage: voltmind provision-personal <email> [--repo-url <git-url>] [--allow-ssh] [--federated] [--scopes "read write"]',
    );
    process.exit(1);
  }
  const repoUrlArg = (i => (i >= 0 ? args[i + 1] : undefined))(args.indexOf('--repo-url'));
  const scopesArg = (i => (i >= 0 ? args[i + 1] : undefined))(args.indexOf('--scopes'));
  const federated = args.includes('--federated');
  const allowSsh = args.includes('--allow-ssh') || (repoUrlArg?.startsWith('ssh://') ?? false) || /^[^@/\s]+@[^:\s]+:/.test(repoUrlArg ?? '');

  let sourceId: string;
  try {
    normalizeCompanyEmail(emailArg);
    sourceId = deriveSourceIdFromEmail(emailArg);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }

  try {
    const result = await withConfiguredSql((sql, engine) =>
      provisionPersonalSource(engine, sql, {
        email: emailArg,
        repoUrl: repoUrlArg,
        federated,
        allowSsh,
        scopes: scopesArg,
      }),
    );

    console.log(`Personal source:  ${result.source_id}${result.alreadyProvisioned ? '  (already existed — no duplicate created)' : ''}`);
    console.log(`  Owner email:     ${result.owner_email}`);
    console.log(`  Clone path:      ${result.clone_path ?? '(none)'}`);
    console.log('');
    console.log(`Thin-client OAuth credential for "${emailArg}":`);
    console.log(`  Client ID:       ${result.client_id}`);
    if (result.client_secret) {
      console.log(`  Client Secret:   ${result.client_secret}\n`);
      console.log('Save the client secret — it will not be shown again.');
    } else {
      console.log('  Client Secret:   <public client — none issued>\n');
    }
    console.log(`  Scopes:          read write (bound to ${result.source_id} only)`);
    console.log('');
    console.log('Hand these to the user agent for:');
    console.log(`  voltmind init --mcp-only --issuer-url <host> --mcp-url <host>/mcp \\`);
    console.log(`    --oauth-client-id ${result.client_id} --oauth-client-secret <secret>`);
  } catch (e) {
    console.error('Error:', (e as Error).message);
    process.exit(1);
  }
}
