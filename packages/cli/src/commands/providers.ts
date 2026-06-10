/**
 * `mastro providers` — list, fetch, and refresh connectors.
 *
 *   mastro providers                 list available connectors
 *   mastro providers add <id>...     fetch latest from GitHub into ~/.mastro/providers
 *   mastro providers update [id...]  re-fetch previously added providers
 */
import { UsageError } from "../args.ts";
import type { CliContext } from "../context.ts";
import { emit, pc, ui } from "../output.ts";
import { DEFAULT_REF, DEFAULT_REPO, fetchProvider, readLock } from "../provider-fetch.ts";

export async function providers(ctx: CliContext, rest: string[], asJson: boolean): Promise<number> {
  const [sub, ...args] = rest;
  switch (sub) {
    case undefined:
    case "list":
      return list(ctx, asJson);
    case "add":
      return add(args, asJson);
    case "update":
      return update(args, asJson);
    default:
      throw new UsageError(`unknown providers subcommand "${sub}". Try: list, add, update.`);
  }
}

function list(ctx: CliContext, asJson: boolean): number {
  const lock = readLock();
  const ids = ctx.registry.list();
  const rows = ids.map((id) => {
    const p = ctx.registry.load(id);
    const loggedIn = ctx.store.get(id) !== undefined;
    return {
      id,
      display_name: p.manifest.display_name,
      has_api: p.spec !== undefined,
      logged_in: loggedIn,
      fetched: lock[id]?.commit.slice(0, 7),
    };
  });

  if (asJson) {
    emit(rows, true);
    return 0;
  }

  if (rows.length === 0) {
    ui.info("No providers found. Add one under providers/<name>/.");
    return 0;
  }

  ui.heading("Available connectors");
  for (const r of rows) {
    const tick = r.logged_in ? pc.green("✓") : pc.dim("·");
    const origin = r.fetched ? pc.dim(` (fetched @${r.fetched})`) : "";
    console.error(`  ${tick} ${pc.bold(r.id.padEnd(14))} ${pc.dim(r.display_name)}${origin}`);
  }
  ui.info("\n✓ = logged in.  Run: mastro login <id>");
  return 0;
}

async function add(args: string[], asJson: boolean): Promise<number> {
  const { ids, repo, ref } = parseFetchArgs(args);
  if (ids.length === 0) {
    throw new UsageError("which provider? e.g. `mastro providers add depop`");
  }
  const results = [];
  for (const id of ids) {
    const entry = await fetchProvider(id, repo, ref);
    results.push({ id, ...entry });
    if (!asJson) ui.success(`${id} @ ${entry.commit.slice(0, 7)} → ~/.mastro/providers/${id}`);
  }
  if (asJson) emit(results, true);
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
  if (asJson) emit(results, true);
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
