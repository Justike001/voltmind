import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { analyzeSkillBrainFirst } from "../src/core/skill-brain-first.ts";
import { parseSkillFrontmatter } from "../src/core/skill-frontmatter.ts";

const SKILLS_DIR = join(import.meta.dir, "..", "skills");
const MANIFEST_PATH = join(SKILLS_DIR, "manifest.json");

/** Simple YAML frontmatter parser — extracts fields between --- delimiters */
function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const yaml = match[1];
  const result: Record<string, string> = {};
  for (const line of yaml.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (key && !key.startsWith(" ") && !key.startsWith("-")) {
        result[key] = value;
      }
    }
  }
  return result;
}

/** Get all skill directories (those containing SKILL.md) */
function getSkillDirs(): string[] {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
  const excluded = new Set(
    (manifest.excluded_skills ?? []).map((entry: { name: string }) => entry.name),
  );
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .filter((e) => existsSync(join(SKILLS_DIR, e.name, "SKILL.md")))
    .map((e) => e.name)
    .filter((name) => !excluded.has(name));
}

describe("skills conformance", () => {
  const skillDirs = getSkillDirs();

  test("manifest.json exists and is valid JSON", () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true);
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
    expect(manifest.skills).toBeDefined();
    expect(Array.isArray(manifest.skills)).toBe(true);
  });

  test("manifest lists every skill directory", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
    const manifestNames = manifest.skills.map((s: { name: string }) => s.name);
    for (const dir of skillDirs) {
      expect(manifestNames).toContain(dir);
    }
  });

  test("every manifest entry points to an existing SKILL.md", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
    for (const skill of manifest.skills) {
      const skillPath = join(SKILLS_DIR, skill.path);
      expect(existsSync(skillPath)).toBe(true);
    }
  });

  for (const dir of skillDirs) {
    describe(`skills/${dir}/SKILL.md`, () => {
      const content = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf-8");

      test("has YAML frontmatter", () => {
        expect(content).toMatch(/^---\r?\n/);
        const fm = parseFrontmatter(content);
        expect(fm).not.toBeNull();
      });

      test("frontmatter has required fields (name, description)", () => {
        const fm = parseFrontmatter(content);
        expect(fm).not.toBeNull();
        expect(fm!.name).toBeDefined();
        expect(fm!.description).toBeDefined();
      });

      test("has a Contract section", () => {
        expect(content).toContain("## Contract");
      });

      test("has an Anti-Patterns section", () => {
        expect(content).toContain("## Anti-Patterns");
      });

      test("has an Output Format section", () => {
        expect(content).toContain("## Output Format");
      });
    });
  }

  test("no duplicate skill names in frontmatter", () => {
    const names: string[] = [];
    for (const dir of skillDirs) {
      const content = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf-8");
      const fm = parseFrontmatter(content);
      if (fm?.name) {
        const name = String(fm.name);
        expect(names).not.toContain(name);
        names.push(name);
      }
    }
  });

  test("brain-writing ingestion skills declare canonical brain-first compliance", () => {
    for (const dir of ["cold-start", "enrich", "ingest"]) {
      const skillPath = join(SKILLS_DIR, dir, "SKILL.md");
      const content = readFileSync(skillPath, "utf-8");
      const result = analyzeSkillBrainFirst(content, dir, parseSkillFrontmatter(content));

      expect(result.status).toBe("ok");
      expect(result.reason).not.toBe("missing_brain_first");
      expect(content).toMatch(/^>\s*\*\*Convention:\*\*[^\n]*brain-first/im);
    }
  });

  test("disk inventory equals published skills plus explicit exclusions", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
    const diskNames = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_DIR, entry.name, "SKILL.md")))
      .map((entry) => entry.name)
      .sort();
    const declared = [
      ...manifest.skills.map((entry: { name: string }) => entry.name),
      ...manifest.excluded_skills.map((entry: { name: string; reason: string }) => {
        expect(entry.reason.trim().length).toBeGreaterThan(0);
        return entry.name;
      }),
    ].sort();
    expect(declared).toEqual(diskNames);
  });

  test("media and voice skills document the thin-client localOnly boundary", () => {
    for (const dir of ["media-ingest", "voice-note-ingest"]) {
      const content = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf-8");
      expect(content).toContain("ExternalFileReferenceV1");
      expect(content).toMatch(/thin client[\s\S]*file_upload/i);
      expect(content).toMatch(/localOnly/);
    }
  });
});
