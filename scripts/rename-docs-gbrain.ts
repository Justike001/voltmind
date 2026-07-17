#!/usr/bin/env bun
/**
 * Replace legacy GBrain branding in documentation with VoltMind branding.
 *
 * Scope:
 *   - Recursively scans docs/ (or the directory passed with --root).
 *   - Rewrites both `gbrain` and the common typo `gbrian`, case-insensitively.
 *   - Preserves title case (`GBrain` -> `VoltMind`) and uppercase names
 *     (`GBRAIN_HOME` -> `VOLTMIND_HOME`).
 *   - Skips binary files.
 *   - Renames file and directory path segments too; use --keep-paths to opt out.
 *
 * Usage:
 *   bun run scripts/rename-docs-gbrain.ts             # rewrite in place
 *   bun run scripts/rename-docs-gbrain.ts --check     # report only
 *   bun run scripts/rename-docs-gbrain.ts --root docs/designs
 *   bun run scripts/rename-docs-gbrain.ts --keep-paths # preserve path names
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const DEFAULT_DOCS_DIR = resolve(import.meta.dir, "..", "docs");
const LEGACY_BRANDING_RE = /gbrian|gbrain/gi;

export interface RenameDocsOptions {
  checkOnly?: boolean;
  renamePaths?: boolean;
}

export interface RenameDocsResult {
  scanned: string[];
  changed: string[];
  renamedPaths: string[];
  replacements: number;
  skippedBinary: string[];
}

function replaceBranding(content: string): { content: string; replacements: number } {
  let replacements = 0;
  const rewritten = content.replace(LEGACY_BRANDING_RE, (match) => {
    replacements += 1;
    if (match === match.toUpperCase()) return "VOLTMIND";
    if (match[0] === match[0].toUpperCase()) return "VoltMind";
    return "voltmind";
  });
  return { content: rewritten, replacements };
}

function collectTextFiles(root: string): { files: string[]; skippedBinary: string[] } {
  const files: string[] = [];
  const skippedBinary: string[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;

      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) continue;

      // Reading bytes first keeps images and other binary artifacts out of the
      // UTF-8 rewrite path. The extension check is only an optimization.
      const bytes = readFileSync(path);
      if (bytes.includes(0)) {
        skippedBinary.push(path);
        continue;
      }
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        skippedBinary.push(path);
        continue;
      }
      files.push(path);
    }
  }

  visit(root);
  return { files, skippedBinary };
}

function renameLegacyPathSegments(root: string, checkOnly: boolean): string[] {
  const candidates: string[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      if (!entry.isDirectory() && !entry.isFile()) continue;

      const rewrittenName = replaceBranding(entry.name).content;
      if (rewrittenName !== entry.name) candidates.push(path);
    }
  }

  visit(root);
  // Rename children before parents so nested paths remain valid during the pass.
  candidates.sort((left, right) => right.length - left.length);

  const renamedPaths: string[] = [];
  for (const path of candidates) {
    const target = join(dirname(path), replaceBranding(basename(path)).content);
    if (existsSync(target)) {
      throw new Error(`Cannot rename ${path}; target already exists: ${target}`);
    }
    renamedPaths.push(`${path} -> ${target}`);
    if (!checkOnly) renameSync(path, target);
  }
  return renamedPaths;
}

export function renameGbrainInDocs(
  root = DEFAULT_DOCS_DIR,
  options: RenameDocsOptions = {},
): RenameDocsResult {
  const resolvedRoot = resolve(root);
  if (!existsSync(resolvedRoot) || !lstatSync(resolvedRoot).isDirectory()) {
    throw new Error(`Documentation directory does not exist: ${resolvedRoot}`);
  }

  const checkOnly = options.checkOnly ?? false;
  const renamedPaths = options.renamePaths === false
    ? []
    : renameLegacyPathSegments(resolvedRoot, checkOnly);
  const { files, skippedBinary } = collectTextFiles(resolvedRoot);
  const scanned: string[] = [];
  const changed: string[] = [];
  let replacements = 0;

  for (const path of files) {
    const content = readFileSync(path, "utf8");
    scanned.push(path);

    const result = replaceBranding(content);
    replacements += result.replacements;
    if (result.content === content) continue;

    changed.push(path);
    if (!checkOnly) {
      writeFileSync(path, result.content, { encoding: "utf8" });
    }
  }

  return { scanned, changed, renamedPaths, replacements, skippedBinary };
}

function printUsage(): void {
  console.log(`Usage: bun run scripts/rename-docs-gbrain.ts [--check] [--root <directory>]`);
}

function parseArgs(args: string[]): { checkOnly: boolean; root: string; renamePaths: boolean } {
  let checkOnly = false;
  let root = DEFAULT_DOCS_DIR;
  let renamePaths = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check") {
      checkOnly = true;
    } else if (arg === "--keep-paths") {
      renamePaths = false;
    } else if (arg === "--root") {
      const value = args[index + 1];
      if (!value) throw new Error("--root requires a directory");
      root = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { checkOnly, root, renamePaths };
}

if (import.meta.main) {
  try {
    const { checkOnly, root, renamePaths } = parseArgs(process.argv.slice(2));
    const result = renameGbrainInDocs(root, { checkOnly, renamePaths });
    console.log(`Scanned ${result.scanned.length} text file(s).`);
    console.log(`Found ${result.replacements} legacy branding occurrence(s).`);
    if (result.renamedPaths.length > 0) {
      console.log(`${checkOnly ? "Would rename" : "Renamed"} ${result.renamedPaths.length} path(s):`);
      for (const path of result.renamedPaths) console.log(`  ${path}`);
    }
    if (result.changed.length > 0) {
      console.log(`${checkOnly ? "Would change" : "Changed"} ${result.changed.length} file(s):`);
      for (const path of result.changed) console.log(`  ${path}`);
    } else {
      console.log("No legacy GBrain branding found. Nothing to do.");
    }
    if (result.skippedBinary.length > 0) {
      console.log(`Skipped ${result.skippedBinary.length} binary/non-UTF-8 file(s).`);
    }
    if (checkOnly) console.log("(--check: no files were modified)");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
