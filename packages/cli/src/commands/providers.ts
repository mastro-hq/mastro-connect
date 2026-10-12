/**
 * `mastro providers` — list, fetch, and refresh connectors.
 *
 *   mastro providers                 list installed connectors
 *   mastro providers available       list the connectors a repo offers
 *   mastro providers add <id>...     fetch latest from a GitHub connector repo into ~/.mastro/providers
 *   mastro providers update [id...]  re-fetch previously added providers
 */
import type { Provider } from "@mastro/core";

import { UsageError } from "../args.ts";
import type { CliContext } from "../context.ts";
import { emit, pc, ui } from "../output.ts";
import { DEFAULT_REF, DEFAULT_REPO, fetchProvider, listRemoteProviders, readLock } from "../provider-fetch.ts";

export async function providers(ctx: CliContext, rest: string[], asJson: boolean): Promise<number> {
  const [sub, ...args] = rest;
  switch (sub) {
    case undefined:
    case "list":
      return list(ctx, asJson);
    case "available":
      return available(ctx, args, asJson);
    case "add":
      return add(args, asJson);
    case "update":
      return update(args, asJson);
    default:
      throw new UsageError(`unknown providers subcommand "${sub}". Try: list, available, add, update.`);
  }
}

async function list(ctx: CliContext, asJson: boolean): Promise<number> {
  const lock = readLock();
  const rows = [];
  for (const id of ctx.registry.list()) {
    let p: Provider;
    try {
      p = ctx.registry.load(id);
    } catch (err) {
      // One broken connector shouldn't hide the rest.
      ui.warn(`${id}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    rows.push({
      id,
      display_name: p.manifest.display_name,
      has_api: p.spec !== undefined,
      logged_in: ctx.store.get(id) !== undefined,
      fetched: lock[id]?.commit.slice(0, 7),
    });
  }

  if (asJson) {
    await emit(rows, true);
    return 0;
  }

  if (rows.length === 0) {
    ui.info("No providers found. See `mastro providers available`, or build one (`mastro skills add mastro-author`).");
    return 0;
  }

  ui.heading("Available connectors");
  for (const r of rows) {
    const tick = r.logged_in ? pc.green("✓") : pc.dim("·");
    const origin = r.fetched ? pc.dim(` (fetched @${r.fetched})`) : "";
    ui.print(`  ${tick} ${pc.bold(r.id.padEnd(18))} ${pc.dim(r.display_name)}${origin}`);
  }
  ui.info("\n✓ = logged in.  Run: mastro login <id>");
  return 0;
}

async function available(ctx: CliContext, args: string[], asJson: boolean): Promise<number> {
  const { ids, repo, ref } = parseFetchArgs(args);
  if (ids.length > 0) throw new UsageError("providers available takes no positionals — use --repo / --ref");
  const installed = new Set(ctx.registry.list());
  const rows = (await listRemoteProviders(repo, ref)).map((p) => ({ ...p, installed: installed.has(p.id) }));

  if (asJson) {
    await emit(rows, true);
    return 0;
  }
  ui.heading(`Connectors in ${repo}@${ref}`);
  for (const r of rows) {
    const tick = r.installed ? pc.green("✓") : pc.dim("·");
    ui.print(`  ${tick} ${pc.bold(r.id.padEnd(18))} ${pc.dim(r.display_name)}`);
  }
  ui.info(`\n✓ = installed.  Add one: mastro providers add <id>${repo === DEFAULT_REPO ? "" : ` --repo ${repo}`}`);
  return 0;
}

async function add(args: string[], asJson: boolean): Promise<number> {
  const { ids, repo, ref } = parseFetchArgs(args);
  if (ids.length === 0) {
    throw new UsageError("which provider? See `mastro providers available`, e.g. `mastro providers add reservecalifornia`");
  }
  const results = [];
  for (const id of ids) {
    const entry = await fetchProvider(id, repo, ref);
    results.push({ id, ...entry });
    if (!asJson) ui.success(`${id} @ ${entry.commit.slice(0, 7)} → ~/.mastro/providers/${id}`);
  }
  if (asJson) await emit(results, true);
  return 0;
}

async function update(args: string[], asJson: boolean): Promise<number> {
  const { ids } = parseFetchArgs(args);
  const lock = readLock();
  const targets = ids.length > 0 ? ids : Object.keys(lock);
  if (targets.length === 0) {
    ui.info("Nothing to update — fetch one first with `mastro providers add <id>`.");
    return 0;
  }

  const results = [];
  for (const id of targets) {
    const pinned = lock[id];
    if (!pinned) throw new UsageError(`"${id}" was never added — run \`mastro providers add ${id}\``);
    const entry = await fetchProvider(id, pinned.repo, pinned.ref);
    results.push({ id, ...entry });
    if (!asJson) ui.success(`${id} @ ${entry.commit.slice(0, 7)}`);
  }
  if (asJson) await emit(results, true);
  return 0;
}

function parseFetchArgs(args: string[]): { ids: string[]; repo: string; ref: string } {
  const ids: string[] = [];
  let repo = DEFAULT_REPO;
  let ref = DEFAULT_REF;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === "--repo" || tok === "--ref") {
      const next = args[++i];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`${tok} needs a value`);
      if (tok === "--repo") repo = next;
      else ref = next;
    } else if (tok.startsWith("--")) {
      throw new UsageError(`unknown flag ${tok}`);
    } else {
      ids.push(tok);
    }
  }
  return { ids, repo, ref };
}
