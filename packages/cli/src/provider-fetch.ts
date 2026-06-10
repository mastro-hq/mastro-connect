/**
 * Fetching providers out-of-band from the mastro-connect GitHub repo.
 *
 * Unofficial APIs drift faster than CLI releases, so `mastro providers add`
 * pulls the latest `providers/<id>/` straight from the repo into
 * `~/.mastro/providers/<id>` (which the registry searches ahead of the
 * bundled copies). Every fetch is pinned to the commit it resolved, recorded
 * in `~/.mastro/providers/.lock.json` so `mastro providers update` can
 * re-fetch from the same repo/ref later.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { UsageError } from "./args.ts";
import { userProvidersDir } from "./context.ts";

export const DEFAULT_REPO = "mastro-hq/mastro-connect";
export const DEFAULT_REF = "main";

export interface ProviderLockEntry {
  repo: string;
  ref: string;
  commit: string;
  fetched_at: string;
}

export type ProviderLock = Record<string, ProviderLockEntry>;

export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchError";
  }
}

/** Download providers/<id>/ at `ref` into ~/.mastro/providers/<id>. */
export async function fetchProvider(id: string, repo: string, ref: string): Promise<ProviderLockEntry> {
  const commit = await resolveCommit(repo, ref);
  const prefix = `providers/${id}/`;
  const paths = (await listTree(repo, commit)).filter((p) => p.startsWith(prefix));
  if (paths.length === 0) {
    throw new UsageError(`no provider "${id}" in ${repo}@${ref} — check \`mastro skills list\` / the repo's providers/ directory`);
  }

  const destRoot = join(userProvidersDir(), id);
  const staged: Array<{ dest: string; body: Uint8Array }> = [];
  for (const path of paths) {
    const rel = path.slice(prefix.length);
    if (rel.split("/").some((seg) => seg === "..")) {
      throw new FetchError(`refusing path traversal in repo tree: ${path}`);
    }
    staged.push({ dest: join(destRoot, rel), body: await download(repo, commit, path) });
  }

  // All downloads succeeded — only now replace the local copy.
  rmSync(destRoot, { recursive: true, force: true });
  for (const { dest, body } of staged) {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
  }

  const entry: ProviderLockEntry = { repo, ref, commit, fetched_at: new Date().toISOString() };
  writeLockEntry(id, entry);
  return entry;
}

export function readLock(): ProviderLock {
  const path = lockPath();
  if (!existsSync(path)) return {};
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (data === null || typeof data !== "object") return {};
  const lock: ProviderLock = {};
  for (const [id, value] of Object.entries(data)) {
    const entry = parseLockEntry(value);
    if (entry) lock[id] = entry;
  }
  return lock;
}

function parseLockEntry(value: unknown): ProviderLockEntry | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { repo, ref, commit, fetched_at } = value as Partial<Record<keyof ProviderLockEntry, unknown>>;
  if (
    typeof repo !== "string" ||
    typeof ref !== "string" ||
    typeof commit !== "string" ||
    typeof fetched_at !== "string"
  ) {
    return undefined;
  }
  return { repo, ref, commit, fetched_at };
}

function writeLockEntry(id: string, entry: ProviderLockEntry): void {
  const lock = readLock();
  lock[id] = entry;
  mkdirSync(userProvidersDir(), { recursive: true });
  writeFileSync(lockPath(), JSON.stringify(lock, null, 2) + "\n");
}

function lockPath(): string {
  return join(userProvidersDir(), ".lock.json");
}

/** GET api.github.com commit for `ref` → full sha. */
async function resolveCommit(repo: string, ref: string): Promise<string> {
  const data = await getJson(`https://api.github.com/repos/${repo}/commits/${ref}`);
  if (data !== null && typeof data === "object" && "sha" in data && typeof data.sha === "string") {
    return data.sha;
  }
  throw new FetchError(`unexpected commit response from GitHub for ${repo}@${ref}`);
}

/** All blob paths in the repo tree at `commit`. */
async function listTree(repo: string, commit: string): Promise<string[]> {
  const data = await getJson(
    `https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`,
  );
  if (data === null || typeof data !== "object" || !("tree" in data) || !Array.isArray(data.tree)) {
    throw new FetchError(`unexpected tree response from GitHub for ${repo}@${commit}`);
  }
  const paths: string[] = [];
  for (const node of data.tree) {
    if (
      node !== null &&
      typeof node === "object" &&
      "type" in node &&
      node.type === "blob" &&
      "path" in node &&
      typeof node.path === "string"
    ) {
      paths.push(node.path);
    }
  }
  return paths;
}

async function download(repo: string, commit: string, path: string): Promise<Uint8Array> {
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${commit}/${path}`, {
    headers: { "User-Agent": "mastro-connect" },
  });
  if (!res.ok) throw new FetchError(`download failed (${res.status}) for ${path}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": "mastro-connect", Accept: "application/vnd.github+json" },
  });
  if (res.status === 403 || res.status === 429) {
    throw new FetchError("GitHub API rate limit hit — try again in a few minutes.");
  }
  if (!res.ok) throw new FetchError(`GitHub API error ${res.status} for ${url}`);
  return res.json();
}
