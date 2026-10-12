/**
 * `mastro validate <provider-dir | id>` — static checks for a connector.
 *
 * Catches what would otherwise only fail at call time: a manifest that doesn't
 * match the schema, a spec that doesn't parse, workflow steps calling missing
 * operations or reading steps/flags that don't exist, resolve sources that
 * aren't there, malformed skills — plus the house rules (no HARs or captured
 * cookies committed, a rate limit set). Exits 1 when any error is found, so it
 * doubles as a connector repo's CI check.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

import {
  manifestOrigins,
  OpenApiSpec,
  parseOpenApi,
  validateManifest,
  type AuthManifest,
  type MastroResolve,
  type MastroWorkflow,
  type OperationView,
} from "@mastro/core";

import { UsageError } from "../args.ts";
import type { CliContext } from "../context.ts";
import { emit, pc, ui } from "../output.ts";
import { readSkill } from "../skill-files.ts";
import { flagsFor } from "./connector.ts";

export interface ValidationReport {
  provider: string;
  dir: string;
  commands: number;
  errors: string[];
  warnings: string[];
}

const SPEC_FILES = ["openapi.yaml", "openapi.yml", "openapi.json"];

export async function validate(ctx: CliContext, rest: string[], asJson: boolean): Promise<number> {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    printHelp();
    return rest.length === 0 ? 1 : 0;
  }

  const reports = rest.map((target) => validateDir(resolveTarget(ctx, target)));
  if (asJson) {
    await emit(reports, true);
  } else {
    for (const r of reports) printReport(r);
  }
  return reports.some((r) => r.errors.length > 0) ? 1 : 0;
}

/** A path to a provider directory, or a provider id the registry can find. */
function resolveTarget(ctx: CliContext, target: string): string {
  const asPath = resolve(target);
  if (existsSync(asPath) && statSync(asPath).isDirectory()) return asPath;
  if (target.includes("/")) throw new UsageError(`no such directory: ${target}`);
  return ctx.registry.load(target).dir;
}

export function validateDir(dir: string): ValidationReport {
  const id = basename(dir);
  const report: ValidationReport = { provider: id, dir, commands: 0, errors: [], warnings: [] };
  const { errors, warnings } = report;

  const manifest = checkManifest(dir, id, errors);

  const specFile = SPEC_FILES.find((f) => existsSync(join(dir, f)));
  if (!specFile) {
    warnings.push("no openapi.yaml — only `mastro login` will work for this connector");
  } else {
    const spec = loadSpec(join(dir, specFile), errors);
    if (spec) {
      report.commands = checkSpec(spec, dir, errors, warnings);
      if (manifest) checkCredentialHosts(spec, manifestOrigins(manifest), errors);
    }
  }

  checkSkills(dir, id, errors);
  checkHygiene(dir, errors);
  if (!existsSync(join(dir, "README.md"))) warnings.push("no README.md");
  return report;
}

function checkManifest(dir: string, id: string, errors: string[]): AuthManifest | undefined {
  const path = join(dir, "auth.manifest.json");
  if (!existsSync(path)) {
    errors.push("auth.manifest.json is missing");
    return undefined;
  }
  try {
    const manifest = validateManifest(JSON.parse(readFileSync(path, "utf8")));
    if (manifest.provider_id !== id) {
      errors.push(`auth.manifest.json provider_id "${manifest.provider_id}" doesn't match the directory name "${id}"`);
    }
    return manifest;
  } catch (err) {
    errors.push(message(err));
    return undefined;
  }
}

/**
 * Every operation that sends the session must target an origin the manifest
 * names — at run time mastro refuses to send credentials anywhere else.
 */
function checkCredentialHosts(spec: OpenApiSpec, origins: readonly string[], errors: string[]): void {
  for (const op of spec.all()) {
    if (op.isPublic || op.isWorkflow) continue;
    let origin: string;
    try {
      origin = new URL(spec.baseUrlFor(op)).origin;
    } catch {
      continue; // a missing/invalid server is reported by checkSpec
    }
    if (!origins.includes(origin)) {
      errors.push(
        `${op.command ?? op.id}: sends the session to ${origin}, which auth.manifest.json doesn't name ` +
          "(add it to permissions.host_permissions, or mark the operation `security: []` if it's public)",
      );
    }
  }
}

/** Regexes a connector ships (extract patterns, workflow output.extract) must compile. */
function checkRegexes(op: OperationView, where: string, errors: string[]): void {
  const patterns: string[] = [];
  const extract = op.operation["x-mastro-extract"];
  if (extract && extract.format !== "flight") {
    for (const field of Object.values(extract.fields)) {
      if ("each" in field) {
        for (const sub of Object.values(field.fields)) if (sub.pattern) patterns.push(sub.pattern);
      } else if (field.pattern) {
        patterns.push(field.pattern);
      }
    }
  }
  for (const step of op.operation["x-mastro-workflow"]?.steps ?? []) {
    if (step.output?.extract) patterns.push(step.output.extract);
  }
  for (const pattern of patterns) {
    try {
      new RegExp(pattern);
    } catch (err) {
      errors.push(`${where}: regex ${JSON.stringify(pattern)} doesn't compile: ${message(err)}`);
    }
  }
}

function loadSpec(path: string, errors: string[]): OpenApiSpec | undefined {
  let spec: OpenApiSpec;
  try {
    spec = parseOpenApi(readFileSync(path, "utf8"));
  } catch (err) {
    errors.push(`${basename(path)} doesn't parse: ${message(err)}`);
    return undefined;
  }
  const version = spec.doc.openapi;
  if (typeof version !== "string" || !version.startsWith("3.1")) {
    errors.push(`openapi must be "3.1.x" (got ${JSON.stringify(version)})`);
  }
  if (spec.doc.paths === null || typeof spec.doc.paths !== "object") {
    errors.push("openapi document has no paths");
    return undefined;
  }
  return spec;
}

/** Returns the number of CLI commands the spec generates. */
function checkSpec(spec: OpenApiSpec, dir: string, errors: string[], warnings: string[]): number {
  const ops = spec.all();

  const ids = new Map<string, number>();
  const commands = new Map<string, number>();
  for (const op of ops) {
    ids.set(op.id, (ids.get(op.id) ?? 0) + 1);
    if (op.command) commands.set(op.command, (commands.get(op.command) ?? 0) + 1);
  }
  for (const [opId, n] of ids) if (n > 1) errors.push(`operationId "${opId}" is used ${n} times`);
  for (const [cmd, n] of commands) if (n > 1) errors.push(`command "${cmd}" is generated by ${n} operations`);

  for (const op of ops) {
    const where = `${op.command ?? op.id}`;
    if (!op.hidden && !op.operation.operationId && !op.operation["x-mastro-command"]) {
      errors.push(`${op.method.toUpperCase()} ${op.path} needs an operationId or x-mastro-command`);
    }
    if (!op.isWorkflow) {
      try {
        spec.baseUrlFor(op);
      } catch {
        errors.push(`${where}: no servers[].url on the document or the operation`);
      }
    }

    const flags = flagsFor(op);
    const flagNames = new Set<string>();
    for (const f of flags) {
      if (flagNames.has(f.name)) errors.push(`${where}: flag --${f.name} is declared twice`);
      flagNames.add(f.name);
    }
    for (const p of op.parameters) checkResolve(p["x-mastro-resolve"], spec, dir, `${where} --${p.name}`, errors);
    for (const a of op.operation["x-mastro-args"] ?? []) {
      checkResolve(a["x-mastro-resolve"], spec, dir, `${where} --${a.name}`, errors);
    }

    // Every ${args.x} a template reads must be a flag the command accepts.
    const templated = JSON.stringify({
      workflow: op.operation["x-mastro-workflow"],
      body: op.operation["x-mastro-body"],
      headers: op.operation["x-mastro-headers"],
      resolve: [...op.parameters, ...(op.operation["x-mastro-args"] ?? [])].map((p) => p["x-mastro-resolve"]),
    });
    for (const name of refs(templated, "args")) {
      if (!flagNames.has(name)) errors.push(`${where}: template reads \${args.${name}} but there is no --${name} flag`);
    }

    const workflow = op.operation["x-mastro-workflow"];
    if (workflow) checkWorkflow(workflow, spec, where, errors, warnings);
    checkRegexes(op, where, errors);
  }

  const rateLimit = spec.replay().rate_limit;
  if (!rateLimit) {
    warnings.push("x-mastro-replay.rate_limit is not set — set requests_per_minute to keep calls at a human pace");
  } else if (!(typeof rateLimit.requests_per_minute === "number" && rateLimit.requests_per_minute >= 1)) {
    errors.push("x-mastro-replay.rate_limit.requests_per_minute must be a number ≥ 1");
  }
  return spec.commands().length;
}

function checkWorkflow(
  workflow: MastroWorkflow,
  spec: OpenApiSpec,
  where: string,
  errors: string[],
  warnings: string[],
): void {
  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    errors.push(`${where}: x-mastro-workflow has no steps`);
    return;
  }
  const seen = new Set<string>();
  for (const step of workflow.steps) {
    if (seen.has(step.id)) errors.push(`${where}: step id "${step.id}" is used twice`);
    if (step.operationId !== undefined && !spec.byOperationId(step.operationId)) {
      errors.push(`${where}: step "${step.id}" calls unknown operationId "${step.operationId}"`);
    }
    // A step may read earlier steps, and itself in poll.until / fail_when.
    seen.add(step.id);
    for (const name of refs(JSON.stringify(step), "steps")) {
      if (!seen.has(name)) errors.push(`${where}: step "${step.id}" reads \${steps.${name}} before it runs`);
    }
  }
  const handoffRefs = workflow.handoff ? refs(JSON.stringify(workflow.handoff), "steps") : [];
  for (const name of handoffRefs) {
    if (!seen.has(name)) errors.push(`${where}: handoff reads unknown step "${name}"`);
  }
  const resultStep = workflow.result?.split(".")[0];
  if (resultStep && !seen.has(resultStep)) errors.push(`${where}: result names unknown step "${resultStep}"`);

  const writes = workflow.steps.some((s) => {
    const target = s.operationId ? spec.byOperationId(s.operationId) : undefined;
    return target !== undefined && target.method !== "get";
  });
  if (writes && !workflow.handoff) {
    warnings.push(`${where}: workflow sends non-GET requests — if it changes state, its skill must require --dry-run and user confirmation first`);
  }
}

function checkResolve(
  resolveSpec: MastroResolve | undefined,
  spec: OpenApiSpec,
  dir: string,
  where: string,
  errors: string[],
): void {
  if (!resolveSpec) return;
  const { from } = resolveSpec;
  if (from.startsWith("file:")) {
    const rel = from.slice("file:".length);
    const path = resolve(dir, rel);
    if (!path.startsWith(resolve(dir) + sep)) {
      errors.push(`${where}: x-mastro-resolve file "${rel}" is outside the connector directory`);
    } else if (!existsSync(path)) {
      errors.push(`${where}: x-mastro-resolve file "${rel}" doesn't exist`);
    }
  } else if (!spec.byOperationId(from)) {
    errors.push(`${where}: x-mastro-resolve from unknown operationId "${from}"`);
  }
}

function checkSkills(dir: string, id: string, errors: string[]): void {
  const skillsDir = join(dir, "skills");
  if (!existsSync(skillsDir)) return;
  for (const name of readdirSync(skillsDir)) {
    const skillDir = join(skillsDir, name);
    if (!statSync(skillDir).isDirectory()) continue;
    try {
      const skill = readSkill(skillDir, `${id}/${name}`);
      if (!skill.name.startsWith(`mastro-${id}-`)) {
        errors.push(`skills/${name}: frontmatter name "${skill.name}" should start with "mastro-${id}-"`);
      }
    } catch (err) {
      errors.push(`skills/${name}: ${message(err)}`);
    }
  }
}

/** Patterns that mean a capture or a live secret was committed. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/"log"\s*:\s*\{\s*"version"/, "looks like a HAR export"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{40,}/, "contains what looks like a live bearer token"],
  [/\b(?:li_at|at-main|sess-at-main|session-token|__Secure-[\w-]+)=[A-Za-z0-9%._~+/-]{20,}/, "contains what looks like a session cookie"],
];

function checkHygiene(dir: string, errors: string[]): void {
  for (const path of walk(dir)) {
    const rel = relative(dir, path);
    if (lstatSync(path).isSymbolicLink()) {
      errors.push(`${rel}: symlinks aren't allowed in a connector`);
      continue;
    }
    if (rel.endsWith(".har")) {
      errors.push(`${rel}: HAR files hold live cookies and tokens — never commit them`);
      continue;
    }
    if (statSync(path).size > 5_000_000) continue;
    const text = readFileSync(path, "utf8");
    for (const [pattern, why] of SECRET_PATTERNS) {
      if (pattern.test(text)) errors.push(`${rel}: ${why}`);
    }
  }
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    // lstat: never follow a symlink (it could loop, or point outside); it's reported instead.
    if (lstatSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** Distinct names referenced as `${<scope>.<name>...}` (fallbacks and paths allowed). */
function refs(text: string, scope: "args" | "steps"): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(new RegExp(`\\$\\{${scope}\\.([A-Za-z_][\\w-]*)`, "g"))) names.add(m[1]!);
  return [...names];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function printReport(r: ValidationReport): void {
  const ok = r.errors.length === 0;
  const head = `${pc.bold(r.provider)} ${pc.dim(`(${r.commands} command${r.commands === 1 ? "" : "s"})`)}`;
  ui.print(`${ok ? pc.green("✓") : pc.red("✗")} ${head}`);
  for (const e of r.errors) ui.print(`  ${pc.red("error")}  ${e}`);
  for (const w of r.warnings) ui.print(`  ${pc.yellow("warn")}   ${w}`);
}

function printHelp(): void {
  ui.print(`mastro validate — static checks for a connector definition.

Usage:
  mastro validate <dir | provider-id>...

Checks the auth manifest against its schema, that the OpenAPI spec parses and
generates commands, workflow steps / templates / resolve sources point at
things that exist, skills have valid frontmatter, and that no HARs or live
credentials are committed. Exits 1 on any error.

Examples:
  mastro validate providers/myapp
  mastro validate providers/*`);
}
