/**
 * Fetching providers out-of-band from a connector repo on GitHub.
 *
 * Connectors live outside the framework (default: the mastro-hq/connectors
 * repo; `--repo` points anywhere else) and drift faster than CLI releases, so
 * `mastro providers add` pulls the latest `providers/<id>/` straight from the
 * repo into `~/.mastro/providers/<id>` (which the registry searches ahead of
 * the bundled copies). Every fetch is pinned to the commit it resolved,
 * recorded in `~/.mastro/providers/.lock.json` so `mastro providers update`
 * can re-fetch from the same repo/ref later.
 *
 * Connector repos may be private: every call goes through api.github.com with
 * a token from GITHUB_TOKEN / GH_TOKEN, else `gh auth token`, when one exists.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { UsageError } from "./args.ts";
import { userProvidersDir } from "./context.ts";

export const DEFAULT_REPO = "mastro-hq/connectors";
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

export interface RemoteProvider {
  id: string;
  display_name: string;
}

/** The connectors a repo offers at `ref`: every providers/<id>/ with a manifest. */
export async function listRemoteProviders(repo: string, ref: string): Promise<RemoteProvider[]> {
  const commit = await resolveCommit(repo, ref);
  const ids = (await listTree(repo, commit))
    .map((p) => p.match(/^providers\/([^/]+)\/auth\.manifest\.json$/)?.[1])
    .filter((id): id is string => id !== undefined);
  return Promise.all(
    ids.map(async (id) => {
      const body = await download(repo, commit, `providers/${id}/auth.manifest.json`);
      return { id, display_name: displayName(new TextDecoder().decode(body)) ?? id };
    }),
  );
}

function displayName(manifestText: string): string | undefined {
  try {
    const data: unknown = JSON.parse(manifestText);
    if (data !== null && typeof data === "object" && "display_name" in data && typeof data.display_name === "string") {
      return data.display_name;
    }
  } catch {
    // a malformed manifest still lists by id
  }
  return undefined;
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
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await github(`https://api.github.com/repos/${repo}/contents/${encoded}?ref=${commit}`, {
    Accept: "application/vnd.github.raw",
  });
  if (!res.ok) throw new FetchError(`download failed (${res.status}) for ${path}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function getJson(url: string): Promise<unknown> {
  const res = await github(url, { Accept: "application/vnd.github+json" });
  if (res.status === 404) {
    throw new FetchError(
      githubToken()
        ? `GitHub returned 404 for ${url} — check the repo/ref, and that your token can read the repo.`
        : `GitHub returned 404 for ${url} — if the repo is private, set GITHUB_TOKEN or run \`gh auth login\`.`,
    );
  }
  if (res.status === 401) {
    throw new FetchError("GitHub rejected the token (401) — refresh GITHUB_TOKEN / `gh auth login`.");
  }
  if (res.status === 403 || res.status === 429) {
    throw new FetchError(
      githubToken()
        ? "GitHub API rate limit hit — try again in a few minutes."
        : "GitHub API rate limit hit — set GITHUB_TOKEN or run `gh auth login` for a higher limit.",
    );
  }
  if (!res.ok) throw new FetchError(`GitHub API error ${res.status} for ${url}`);
  return res.json();
}

function github(url: string, headers: Record<string, string>): Promise<Response> {
  const token = githubToken();
  return fetch(url, {
    headers: {
      "User-Agent": "mastro-connect",
      "X-GitHub-Api-Version": "2022-11-28",
      ...headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

let cachedToken: string | null | undefined;

/** GITHUB_TOKEN / GH_TOKEN, else the GitHub CLI's token, else none (public repos only). */
function githubToken(): string | undefined {
  if (cachedToken === undefined) {
    cachedToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ghCliToken() || null;
  }
  return cachedToken ?? undefined;
}

function ghCliToken(): string | undefined {
  try {
    const proc = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
    const token = proc.stdout.toString().trim();
    return proc.success && token ? token : undefined;
  } catch {
    return undefined; // gh not installed
  }
}
