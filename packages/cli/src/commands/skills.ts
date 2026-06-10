/**
 * `mastro skills` — distribute provider playbooks into agent skills folders.
 *
 *   mastro skills list [provider]            what's available
 *   mastro skills add <provider>[/<skill>]   install (plus the root mastro skill)
 *   mastro skills update                     refresh everything installed here
 *
 * Install target: ./.claude/skills (project) by default; --global for
 * ~/.claude/skills; --dir <path> for anything else (e.g. .agents/skills).
 */
import { join } from "node:path";

import { UsageError } from "../args.ts";
import { packageRoot, type CliContext } from "../context.ts";
import { emit, pc, ui } from "../output.ts";
import {
  installSkill,
  installTarget,
  installedSkills,
  providerSkills,
  readSkill,
  type SkillInfo,
} from "../skill-files.ts";

const ROOT_SKILL = "mastro";

export function skills(ctx: CliContext, rest: string[], asJson: boolean): number {
  const [sub, ...args] = rest;
  switch (sub) {
    case "list":
      return list(ctx, args[0], asJson);
    case "add":
      return add(ctx, args, asJson);
    case "update":
      return update(ctx, args, asJson);
    case undefined:
    case "--help":
    case "-h":
      printHelp();
      return sub === undefined ? 1 : 0;
    default:
      throw new UsageError(`unknown skills subcommand "${sub}". Try: list, add, update.`);
  }
}

/** The general mastro skill, shipped at the package root next to providers/. */
function rootSkill(): SkillInfo {
  return readSkill(join(packageRoot(), "skills", ROOT_SKILL), ROOT_SKILL);
}

/** Resolve "<provider>" or "<provider>/<skill>" specs into skills to install. */
function resolveSpec(ctx: CliContext, spec: string): SkillInfo[] {
  if (spec === ROOT_SKILL) return [rootSkill()];

  const [providerId, skillName, extra] = spec.split("/");
  if (!providerId || extra !== undefined) {
    throw new UsageError(`bad skill spec "${spec}" — use <provider> or <provider>/<skill>`);
  }
  const provider = ctx.registry.load(providerId);
  const available = providerSkills(provider.id, provider.dir);
  if (available.length === 0) {
    throw new UsageError(`provider "${providerId}" ships no skills`);
  }
  if (skillName === undefined) return available;

  const found = available.find((s) => s.source === `${providerId}/${skillName}`);
  if (!found) {
    const names = available.map((s) => s.source).join(", ");
    throw new UsageError(`no skill "${spec}". Available: ${names}`);
  }
  return [found];
}

function list(ctx: CliContext, providerId: string | undefined, asJson: boolean): number {
  const providerIds = providerId ? [providerId] : ctx.registry.list();
  const rows: SkillInfo[] = [rootSkill()];
  for (const id of providerIds) {
    const provider = ctx.registry.load(id);
    rows.push(...providerSkills(provider.id, provider.dir));
  }

  if (asJson) {
    emit(rows.map(({ source, name, description }) => ({ source, name, description })), true);
    return 0;
  }

  ui.heading("Available skills");
  for (const s of rows) {
    console.error(`  ${pc.bold(s.source.padEnd(18))} ${pc.dim(truncate(s.description, 80))}`);
  }
  ui.info("\nInstall: mastro skills add <provider>[/<skill>]  [--global | --dir <path>]");
  return 0;
}

function add(ctx: CliContext, args: string[], asJson: boolean): number {
  const { specs, flags } = splitFlags(args);
  if (specs.length === 0) {
    throw new UsageError("what to add? e.g. `mastro skills add depop` or `mastro skills add depop/search`");
  }
  const target = installTarget(flags);

  // Dedup by name: the root mastro skill rides along with every install so
  // the agent always has the session-model context.
  const toInstall = new Map<string, SkillInfo>();
  toInstall.set(ROOT_SKILL, rootSkill());
  for (const spec of specs) {
    for (const skill of resolveSpec(ctx, spec)) toInstall.set(skill.name, skill);
  }

  const installed = [...toInstall.values()].map((skill) => ({
    source: skill.source,
    name: skill.name,
    path: installSkill(skill, target),
  }));

  if (asJson) {
    emit(installed, true);
    return 0;
  }
  for (const s of installed) ui.success(`${s.name} → ${s.path}`);
  ui.info("Restart your agent session (or /reload skills) to pick them up.");
  return 0;
}

function update(ctx: CliContext, args: string[], asJson: boolean): number {
  const { specs, flags } = splitFlags(args);
  if (specs.length > 0) throw new UsageError("skills update takes no positionals — it refreshes everything installed in the target");
  const target = installTarget(flags);

  const results: Array<{ source: string; name: string; status: "updated" | "missing-source" }> = [];
  for (const { provenance } of installedSkills(target)) {
    let skill: SkillInfo | undefined;
    try {
      [skill] = resolveSpec(ctx, provenance.source);
    } catch {
      skill = undefined;
    }
    if (!skill) {
      results.push({ source: provenance.source, name: provenance.source, status: "missing-source" });
      continue;
    }
    installSkill(skill, target);
    results.push({ source: skill.source, name: skill.name, status: "updated" });
  }

  if (asJson) {
    emit(results, true);
    return 0;
  }
  if (results.length === 0) {
    ui.info(`No mastro-managed skills found in ${target}.`);
    return 0;
  }
  for (const r of results) {
    if (r.status === "updated") ui.success(`${r.name} refreshed`);
    else ui.warn(`${r.source}: source no longer available (provider removed?) — left as-is`);
  }
  return 0;
}

/** skills subcommands take only boolean --global and string --dir. */
function splitFlags(args: string[]): {
  specs: string[];
  flags: Record<string, string | boolean | string[]>;
} {
  const specs: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === "--global") {
      flags["global"] = true;
    } else if (tok === "--dir") {
      const next = args[++i];
      if (next === undefined || next.startsWith("--")) throw new UsageError("--dir needs a path");
      flags["dir"] = next;
    } else if (tok.startsWith("--")) {
      throw new UsageError(`unknown flag ${tok}`);
    } else {
      specs.push(tok);
    }
  }
  return { specs, flags };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function printHelp(): void {
  console.error(`mastro skills — install agent skills for connectors.

Usage:
  mastro skills list [provider]              List available skills
  mastro skills add <provider>[/<skill>]...  Install skills (+ the root mastro skill)
  mastro skills update                       Refresh installed skills in the target

Target (for add/update):
  (default)        ./.claude/skills          project-level
  --global         ~/.claude/skills          all your projects
  --dir <path>     anywhere (e.g. .agents/skills)

Examples:
  mastro skills add depop
  mastro skills add amazon/search amazon/detail --global
  mastro skills update`);
}
