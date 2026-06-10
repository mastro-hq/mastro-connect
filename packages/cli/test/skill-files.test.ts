import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UsageError } from "../src/args.ts";
import {
  installSkill,
  installTarget,
  installedSkills,
  providerSkills,
  readSkill,
} from "../src/skill-files.ts";

function makeSkillDir(root: string, name: string, frontmatter: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n# ${name}\nbody\n`);
  return dir;
}

describe("readSkill", () => {
  test("parses name and description from frontmatter", () => {
    const root = mkdtempSync(join(tmpdir(), "mastro-skills-"));
    const dir = makeSkillDir(root, "search", "name: mastro-depop-search\ndescription: Find things.");
    const skill = readSkill(dir, "depop/search");
    expect(skill).toEqual({
      source: "depop/search",
      name: "mastro-depop-search",
      description: "Find things.",
      dir,
    });
  });

  test("rejects a SKILL.md without frontmatter", () => {
    const root = mkdtempSync(join(tmpdir(), "mastro-skills-"));
    const dir = join(root, "bare");
    mkdirSync(dir);
    writeFileSync(join(dir, "SKILL.md"), "# no frontmatter\n");
    expect(() => readSkill(dir, "x/bare")).toThrow(UsageError);
  });

  test("rejects frontmatter missing a description", () => {
    const root = mkdtempSync(join(tmpdir(), "mastro-skills-"));
    const dir = makeSkillDir(root, "incomplete", "name: only-a-name");
    expect(() => readSkill(dir, "x/incomplete")).toThrow(/name and description/);
  });
});

describe("providerSkills", () => {
  test("lists skill directories, skips non-skill entries", () => {
    const provider = mkdtempSync(join(tmpdir(), "mastro-provider-"));
    const skillsRoot = join(provider, "skills");
    makeSkillDir(skillsRoot, "search", "name: mastro-p-search\ndescription: d");
    makeSkillDir(skillsRoot, "order", "name: mastro-p-order\ndescription: d");
    mkdirSync(join(skillsRoot, "empty-dir")); // no SKILL.md → ignored
    writeFileSync(join(skillsRoot, "stray.md"), "not a skill");

    const found = providerSkills("p", provider);
    expect(found.map((s) => s.source)).toEqual(["p/order", "p/search"]);
  });

  test("returns [] for a provider with no skills directory", () => {
    const provider = mkdtempSync(join(tmpdir(), "mastro-provider-"));
    expect(providerSkills("p", provider)).toEqual([]);
  });
});

describe("installSkill / installedSkills", () => {
  test("copies the directory under the skill name and stamps provenance", () => {
    const root = mkdtempSync(join(tmpdir(), "mastro-skills-"));
    const dir = makeSkillDir(root, "search", "name: mastro-depop-search\ndescription: d");
    writeFileSync(join(dir, "extra.json"), "{}"); // sidecar resources travel too
    const target = join(root, "out");

    const dest = installSkill(readSkill(dir, "depop/search"), target);

    expect(dest).toBe(join(target, "mastro-depop-search"));
    expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toContain("mastro-depop-search");
    expect(readFileSync(join(dest, "extra.json"), "utf8")).toBe("{}");

    const installed = installedSkills(target);
    expect(installed).toHaveLength(1);
    expect(installed[0]!.provenance.source).toBe("depop/search");
  });

  test("ignores unmanaged directories and corrupt sidecars", () => {
    const root = mkdtempSync(join(tmpdir(), "mastro-skills-"));
    const target = join(root, "out");
    mkdirSync(join(target, "hand-written-skill"), { recursive: true });
    mkdirSync(join(target, "corrupt"), { recursive: true });
    writeFileSync(join(target, "corrupt", ".mastro.json"), `{"source": 42}`);

    expect(installedSkills(target)).toEqual([]);
  });

  test("returns [] for a missing target", () => {
    expect(installedSkills(join(tmpdir(), "does-not-exist-xyz"))).toEqual([]);
  });
});

describe("installTarget", () => {
  test("defaults to project .claude/skills", () => {
    expect(installTarget({})).toBe(join(process.cwd(), ".claude", "skills"));
  });

  test("--dir wins over --global", () => {
    expect(installTarget({ dir: "/tmp/x", global: true })).toBe("/tmp/x");
  });

  test("--global targets the home skills folder", () => {
    expect(installTarget({ global: true })).toContain(join(".claude", "skills"));
    expect(installTarget({ global: true })).not.toBe(join(process.cwd(), ".claude", "skills"));
  });

  test("rejects a boolean --dir", () => {
    expect(() => installTarget({ dir: true })).toThrow(UsageError);
  });
});
