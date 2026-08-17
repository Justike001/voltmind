import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const SKILLS = join(ROOT, "skills");

function skillMarkdown(): string[] {
  return readdirSync(SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(SKILLS, entry.name, "SKILL.md"))
    .filter((path) => {
      try {
        readFileSync(path, "utf8");
        return true;
      } catch {
        return false;
      }
    });
}

function fencedShellBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```(?:bash|sh|shell)\r?\n([\s\S]*?)```/gi)]
    .map((match) => match[1]);
}

describe("published skill and tutorial command contracts", () => {
  test("fenced skill commands do not use removed CLI operation names or placeholders", () => {
    const violations: string[] = [];
    for (const path of skillMarkdown()) {
      for (const block of fencedShellBlocks(readFileSync(path, "utf8"))) {
        if (/^\s*(?:\$\s*)?voltmind\s+put_page\b/m.test(block)) {
          violations.push(`${path}: use voltmind put, not voltmind put_page`);
        }
        if (/^\s*(?:\$\s*)?voltmind\s+get_page\b/m.test(block)) {
          violations.push(`${path}: use voltmind get, not voltmind get_page`);
        }
        if (/voltmind\s+get\b[^\n]*\s--raw\b|whatever flag exposes raw body/i.test(block)) {
          violations.push(`${path}: voltmind get --raw is not a CLI contract`);
        }
        if (/\bvoltmind_SOURCE\b/.test(block)) {
          violations.push(`${path}: environment variable must be VOLTMIND_SOURCE`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("setup separates non-secret routing config from the client secret", () => {
    const setup = readFileSync(join(SKILLS, "setup", "SKILL.md"), "utf8");
    expect(setup).toContain("Never put it in\n`AGENTS.md`");
    expect(setup).toContain("VOLTMIND_REMOTE_CLIENT_SECRET");
    expect(setup).toContain("--vault-path ~/vault");
    expect(setup).not.toMatch(/Mirror these into your repo's `AGENTS\.md`[\s\S]{0,180}CLIENT_SECRET/i);
    expect(setup).not.toMatch(/voltage3d\.tailce7d39|192\.168\.5\.6/);
  });

  test("company-brain tutorial uses a remote MCP connector, not a thin-client serve bridge", () => {
    const tutorial = readFileSync(join(ROOT, "docs", "tutorials", "company-brain.md"), "utf8");
    const part10 = tutorial.slice(tutorial.indexOf("## Part 10:"), tutorial.indexOf("## Part 11:"));
    expect(part10).toContain("remote MCP");
    expect(part10).not.toContain('"args": ["serve"]');
    expect(part10).not.toContain("local `voltmind serve` stdio bridge");
  });
});
