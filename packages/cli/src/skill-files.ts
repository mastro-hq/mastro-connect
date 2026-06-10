/**
 * Reading and installing agent skills.
 *
 * A skill is a directory containing a SKILL.md with YAML frontmatter
 * (`name`, `description`). Provider skills live in `providers/<id>/skills/`;
 * the root `mastro` skill lives in the package's `skills/` directory.
 * Installing copies the directory into an agent skills folder (`.claude/skills`
 * by default) under the skill's frontmatter name, plus a `.mastro.json`
 * provenance sidecar so `mastro skills update` can refresh it later.
 */
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { UsageError } from "./args.ts";
import { VERSION } from "./version.ts";

export interface SkillInfo {
  /** "depop/search" for provider skills, "mastro" for the root skill. */
  source: string;
  /** Frontmatter `name` — also the installed directory name. */
  name: string;
  description: string;
  /** Absolute path of the skill directory to copy. */
  dir: string;
}

/** Provenance sidecar written into every installed skill directory. */
export interface SkillProvenance {
  source: string;
  version: string;
  installed_at: string;
}

const SIDECAR = ".mastro.json";

/**
 * Parse the `name:` and `description:` lines out of SKILL.md frontmatter.
 * Mastro skill frontmatter is deliberately flat single-line YAML, so a full
 * YAML parser isn't needed.
 */
export function readSkill(dir: string, source: string): SkillInfo {
  const path = join(dir, "SKILL.md");
  const text = readFileSync(path, "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new UsageError(`${path} has no frontmatter block`);

  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.+)$/);
    if (kv) fields.set(kv[1]!, kv[2]!.trim());
  }
  const name = fields.get("name");
  const description = fields.get("description");
  if (!name || !description) {
    throw new UsageError(`${path} frontmatter must define single-line name and description`);
  }
  return { source, name, description, dir };
}

/** All skills shipped by one provider directory (empty if it has none). */
export function providerSkills(providerId: string, providerDir: string): SkillInfo[] {
  const root = join(providerDir, "skills");
  if (!existsSync(root)) return [];
  const out: SkillInfo[] = [];
  for (const entry of readdirSync(root).sort()) {
    const dir = join(root, entry);
    if (statSync(dir).isDirectory() && existsSync(join(dir, "SKILL.md"))) {
      out.push(readSkill(dir, `${providerId}/${entry}`));
    }
  }
  return out;
}

/**
 * Resolve the install target from flags:
 *   default      → ./.claude/skills   (project-level)
 *   --global     → ~/.claude/skills
 *   --dir <path> → anywhere (e.g. .agents/skills)
 */
export function installTarget(flags: Record<string, string | boolean | string[]>): string {
  const dir = flags["dir"];
  if (typeof dir === "string") return resolve(dir);
  if (dir !== undefined) throw new UsageError("--dir needs a path");
  if (flags["global"] === true) return join(homedir(), ".claude", "skills");
  return resolve(".claude", "skills");
}

/** Copy a skill into `target/<skill.name>/` and stamp provenance. Returns the path. */
export function installSkill(skill: SkillInfo, target: string): string {
  const dest = join(target, skill.name);
  cpSync(skill.dir, dest, { recursive: true });
  const provenance: SkillProvenance = {
    source: skill.source,
    version: VERSION,
    installed_at: new Date().toISOString(),
  };
  writeFileSync(join(dest, SIDECAR), JSON.stringify(provenance, null, 2) + "\n");
  return dest;
}

/** Installed mastro-managed skills under `target` (dirs carrying a sidecar). */
export function installedSkills(target: string): Array<{ dir: string; provenance: SkillProvenance }> {
  if (!existsSync(target)) return [];
  const out: Array<{ dir: string; provenance: SkillProvenance }> = [];
  for (const entry of readdirSync(target).sort()) {
    const dir = join(target, entry);
    const sidecar = join(dir, SIDECAR);
    if (!statSync(dir).isDirectory() || !existsSync(sidecar)) continue;
    const provenance = parseProvenance(readFileSync(sidecar, "utf8"));
    if (provenance) out.push({ dir, provenance });
  }
  return out;
}

/** Validate a sidecar's shape; a corrupt one is skipped rather than crashing. */
function parseProvenance(text: string): SkillProvenance | undefined {
  const data: unknown = JSON.parse(text);
  if (data === null || typeof data !== "object") return undefined;
  const { source, version, installed_at } = data as Partial<Record<keyof SkillProvenance, unknown>>;
  if (typeof source !== "string" || typeof version !== "string" || typeof installed_at !== "string") {
    return undefined;
  }
  return { source, version, installed_at };
}
