#!/usr/bin/env bun
/**
 * Neutralize `gbrain` branding inside skill docs and skill directories.
 *
 * Why: VoltMind's `skills/` tree is aligned to the upstream GBrain skillpack
 * (copied / synced from `E:\gbrain\gbrain\skills`). After that alignment, every
 * `gbrain` reference should read `voltmind` so the docs + skill names match the
 * runtime the user actually runs.
 *
 * Scope (per alignment request):
 *   - Runs over every skill under `skills/` EXCEPT `cold-start` and `setup`,
 *     which were hand-edited and must not be touched.
 *   - Rewrites the ENTIRE SKILL.md (YAML frontmatter AND body prose), so
 *     `name:`, `description:`, triggers, and prose all read VoltMind.
 *   - Renames any skill DIRECTORY whose name starts with the `gbrain` prefix
 *     (e.g. `gbrain-advisor` -> `voltmind-advisor`) so the directory name and
 *     the frontmatter `name:` stay consistent.
 *   - Case-insensitive: `gbrain`, `Gbrain`, `GBrain`, `GBRAIN`, `gBrain` … are
 *     all rewritten to the lowercase `voltmind`, covering every casing variant.
 *
 * This is a pure string substitution on file text plus a directory rename; it
 * does not touch env vars used by code or anything outside `skills/`.
 *
 * Run:
 *   bun run scripts/rename-skill-gbrain.ts            # rewrite in place
 *   bun run scripts/rename-skill-gbrain.ts --check    # report only, no writes
 *
 * Returns a summary of directories renamed, files changed, and replacements.
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";

const SKILLS_DIR = resolve(import.meta.dir, "..", "skills");
const EXCLUDED = new Set(["cold-start", "setup"]);
const GRAIN_RE = /gbrain/gi;
const REPLACEMENT = "voltmind";
const DIR_PREFIX_RE = /^gbrain/i; // directory-name prefix, case-insensitive

export interface RenameResult {
  scanned: string[];
  renamedDirs: string[];
  changed: string[];
  replacements: number;
}

/**
 * Align GBrain skill branding to VoltMind:
 *   1. Rename any skill directory whose name starts with `gbrain` so the prefix
 *      becomes `voltmind` (e.g. `gbrain-advisor` -> `voltmind-advisor`).
 *   2. Replace every case-variant of "gbrain" with "voltmind" throughout each
 *      skill's SKILL.md — frontmatter AND body.
 *
 * `cold-start` and `setup` are always skipped (hand-edited, do not touch).
 * Optionally dry-run with `{ checkOnly: true }`.
 */
export function renameGbrainInSkills(opts: { checkOnly?: boolean } = {}): RenameResult {
  const checkOnly = opts.checkOnly ?? false;
  const scanned: string[] = [];
  const renamedDirs: string[] = [];
  const changed: string[] = [];
  let replacements = 0;

  // Pass 1: rename skill directories carrying the `gbrain` prefix.
  for (const entry of readdirSync(SKILLS_DIR)) {
    if (EXCLUDED.has(entry)) continue;
    const skillDir = join(SKILLS_DIR, entry);
    if (!statSync(skillDir).isDirectory()) continue;
    const m = DIR_PREFIX_RE.exec(entry);
    if (!m) continue;
    const newName = REPLACEMENT + entry.slice(m[0].length);
    if (newName === entry) continue;
    const newDir = join(SKILLS_DIR, newName);
    if (existsSync(newDir)) {
      console.warn(`[skip] target directory already exists: ${newName}`);
      continue;
    }
    renamedDirs.push(`${entry} -> ${newName}`);
    if (!checkOnly) renameSync(skillDir, newDir);
  }

  // Pass 2: rewrite the full SKILL.md (frontmatter + body) for every skill.
  // Re-read the directory after Pass 1 so renamed skills are picked up.
  for (const entry of readdirSync(SKILLS_DIR)) {
    if (EXCLUDED.has(entry)) continue;
    const skillDir = join(SKILLS_DIR, entry);
    if (!statSync(skillDir).isDirectory()) continue;

    const skillMd = join(skillDir, "SKILL.md");
    let content: string;
    try {
      content = readFileSync(skillMd, "utf8");
    } catch {
      continue; // no SKILL.md in this skill dir
    }
    scanned.push(entry);

    const newContent = content.replace(GRAIN_RE, () => {
      replacements++;
      return REPLACEMENT;
    });

    if (newContent === content) continue; // nothing to change in this file

    changed.push(entry);
    if (!checkOnly) {
      writeFileSync(skillMd, newContent, "utf8");
    }
  }

  return { scanned, renamedDirs, changed, replacements };
}

// CLI entrypoint
if (import.meta.main) {
  const checkOnly = process.argv.includes("--check");
  const result = renameGbrainInSkills({ checkOnly });
  console.log(`Scanned ${result.scanned.length} skills (excluding cold-start, setup).`);
  if (result.renamedDirs.length > 0) {
    console.log(`Renamed ${result.renamedDirs.length} directorie(s):`);
    result.renamedDirs.forEach((d) => console.log(`  ${d}`));
  }
  if (result.changed.length === 0) {
    console.log("No `gbrain` references found in any SKILL.md. Nothing to do.");
  } else {
    console.log(
      `Rewrote ${result.changed.length} skill(s), ${result.replacements} occurrence(s) of "gbrain" -> "voltmind".`,
    );
    if (checkOnly) {
      console.log("(--check: no files were modified)");
      console.log("Would change: " + result.changed.join(", "));
    } else {
      console.log("Changed: " + result.changed.join(", "));
    }
  }
}
