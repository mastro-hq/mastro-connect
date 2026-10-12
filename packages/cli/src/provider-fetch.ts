/**
 * Fetching providers out-of-band from a connector repo on GitHub.
 *
 * Connectors live outside the framework (default: the mastro-hq/connectors
 * catalog; `--repo` points anywhere else) and drift faster than CLI releases, so
 * `mastro providers add` pulls the latest `providers/<id>/` straight from the
 * repo into `~/.mastro/providers/<id>` (where the registry finds it; calling
 * an uninstalled connector does the same from the catalog — see
 * ensure-provider.ts). Every fetch is pinned to the commit it resolved,
 * recorded in `~/.mastro/providers/.lock.json` so `mastro providers update`
 * can re-fetch from the same repo/ref later.
 *
 * Public repos are read anonymously and without the REST API (see
 * `snapshot`); a private repo falls back to the API with a token from
 * GITHUB_TOKEN / GH_TOKEN, else `gh auth token` — sent only to api.github.com.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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

/** The repo was reachable but has no providers/<id>/ at that ref. */
export class ProviderNotInRepoError extends UsageError {
  constructor(
    readonly providerId: string,
    readonly repo: string,
    readonly ref: string,
  ) {
    super(`no provider "${providerId}" in ${repo}@${ref} — see \`mastro providers available${repo === DEFAULT_REPO ? "" : ` --repo ${repo}`}\``);
    this.name = "ProviderNotInRepoError";
  }
}

/** Provider ids are directory names: plain slugs only (no dots, slashes, or leading dash). */
export const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface RemoteProvider {
  id: string;
  display_name: string;
}

/** The connectors a repo offers at `ref`: every providers/<id>/ with a manifest. */
export async function listRemoteProviders(repo: string, ref: string): Promise<RemoteProvider[]> {
  const { files } = await snapshot(repo, ref);
  const out: RemoteProvider[] = [];
  for (const [path, body] of files) {
    const id = path.match(/^providers\/([^/]+)\/auth\.manifest\.json$/)?.[1];
    if (id === undefined || !PROVIDER_ID.test(id)) continue;
    out.push({ id, display_name: displayName(new TextDecoder().decode(body)) ?? id });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
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

/** Caps: a connector is a few small text files; a catalog snapshot is a small repo. */
const MAX_FILE_BYTES = 5_000_000;
const MAX_PROVIDER_BYTES = 20_000_000;
const MAX_ARCHIVE_BYTES = 50_000_000;

/**
 * Download providers/<id>/ at `ref` into ~/.mastro/providers/<id>.
 *
 * Atomic: files land in a hidden staging directory that is renamed into place
 * only once complete, so a crash, a full disk, or two agents installing the
 * same connector at once never leave a half-written connector behind.
 */
export async function fetchProvider(id: string, repo: string, ref: string): Promise<ProviderLockEntry> {
  if (!PROVIDER_ID.test(id)) throw new UsageError(`"${id}" isn't a valid connector id`);
  const { commit, files } = await snapshot(repo, ref);
  const prefix = `providers/${id}/`;
  const paths = [...files.keys()].filter((p) => p.startsWith(prefix));
  if (paths.length === 0) throw new ProviderNotInRepoError(id, repo, ref);

  const root = userProvidersDir();
  mkdirSync(root, { recursive: true });
  const staging = join(root, `.staging-${id}-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    let total = 0;
    for (const path of paths) {
      const rel = path.slice(prefix.length);
      if (rel.split("/").some((seg) => seg === ".." || seg === "")) {
        throw new FetchError(`refusing path traversal in repo tree: ${path}`);
      }
      const body = files.get(path)!;
      if (body.byteLength > MAX_FILE_BYTES) throw new FetchError(`${path} is larger than ${MAX_FILE_BYTES} bytes`);
      total += body.byteLength;
      if (total > MAX_PROVIDER_BYTES) throw new FetchError(`connector "${id}" is larger than ${MAX_PROVIDER_BYTES} bytes`);
      const dest = join(staging, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, body);
    }
    swapIntoPlace(staging, join(root, id));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  const entry: ProviderLockEntry = { repo, ref, commit, fetched_at: new Date().toISOString() };
  writeLockEntry(id, entry);
  return entry;
}

/** Replace `dest` with the complete `staging` directory using renames only. */
function swapIntoPlace(staging: string, dest: string): void {
  const old = `${dirname(dest)}/.old-${basename(dest)}-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    renameSync(dest, old);
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err; // first install: nothing to move aside
  }
  try {
    renameSync(staging, dest);
  } catch (err) {
    // A concurrent install of the same connector got there first: keep theirs.
    if (!isErrno(err, "ENOTEMPTY") && !isErrno(err, "EEXIST")) throw err;
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code;
}

/** The lockfile, or {} if it's missing or unreadable (it's a cache of where things came from). */
export function readLock(): ProviderLock {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(lockPath(), "utf8"));
  } catch {
    return {};
  }
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

/** Read-modify-write the lockfile, replacing it atomically (write a temp file, rename over). */
function writeLockEntry(id: string, entry: ProviderLockEntry): void {
  const lock = readLock();
  lock[id] = entry;
  mkdirSync(userProvidersDir(), { recursive: true });
  const tmp = `${lockPath()}.${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(lock, null, 2) + "\n");
  renameSync(tmp, lockPath());
}

function lockPath(): string {
  return join(userProvidersDir(), ".lock.json");
}

// -- fetching a repo snapshot ------------------------------------------------
//
// A public repo is read without GitHub's REST API (60 calls/hour per IP for
// anonymous clients — a shared office network would exhaust it on launch day):
// the branch is resolved through git's own smart-HTTP ref advertisement, and
// the files come from one codeload tarball at that commit. Two plain requests,
// one consistent snapshot. A private repo (401 there) goes through the API
// with the user's token instead.

interface Snapshot {
  commit: string;
  /** Repo-relative path → file bytes. */
  files: Map<string, Uint8Array>;
}

const snapshots = new Map<string, Promise<Snapshot>>();

/** The repo's files at `ref`, fetched once per process (setup installs several connectors). */
function snapshot(repo: string, ref: string): Promise<Snapshot> {
  const key = `${repo}@${ref}`;
  let pending = snapshots.get(key);
  if (!pending) {
    pending = loadSnapshot(repo, ref);
    snapshots.set(key, pending);
    pending.catch(() => snapshots.delete(key));
  }
  return pending;
}

async function loadSnapshot(repo: string, ref: string): Promise<Snapshot> {
  const anonymous = await resolveAnonymously(repo, ref);
  if (anonymous) {
    const res = await github(`https://codeload.github.com/${repo}/tar.gz/${anonymous}`, {}, undefined);
    if (!res.ok) throw new FetchError(`couldn't download ${repo}@${anonymous.slice(0, 7)} (${res.status})`);
    return { commit: anonymous, files: await unpack(res) };
  }
  const token = githubToken();
  if (!token) {
    throw new FetchError(
      `couldn't read ${repo}@${ref} — if the repo is private, set GITHUB_TOKEN or run \`gh auth login\`.`,
    );
  }
  const commit = await resolveCommitViaApi(repo, ref, token);
  const res = await github(`https://api.github.com/repos/${repo}/tarball/${commit}`, {}, token);
  if (!res.ok) throw new FetchError(`couldn't download ${repo}@${commit.slice(0, 7)} (${res.status})`);
  return { commit, files: await unpack(res) };
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The commit `ref` names, from git's smart-HTTP ref advertisement — no API
 * quota, no token. A full sha resolves to itself. Undefined when the repo
 * isn't publicly readable (private, or missing) or `ref` isn't a branch/tag.
 */
async function resolveAnonymously(repo: string, ref: string): Promise<string | undefined> {
  if (FULL_SHA.test(ref)) return ref;
  const res = await github(`https://github.com/${repo}.git/info/refs?service=git-upload-pack`, {}, undefined);
  if (res.status === 401 || res.status === 404) return undefined;
  if (!res.ok) throw new FetchError(`couldn't list ${repo}'s branches (${res.status})`);
  const wanted = new Set([`refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`]);
  let tag: string | undefined;
  for (const line of (await res.text()).split("\n")) {
    const match = line.match(/([0-9a-f]{40}) ([^\s\0]+)/);
    if (!match || !wanted.has(match[2]!)) continue;
    if (match[2] === `refs/heads/${ref}` || match[2] === `refs/tags/${ref}^{}`) return match[1]!;
    tag = match[1]; // a lightweight tag (no peeled ^{} line)
  }
  return tag;
}

/** GET api.github.com commit for `ref` → full sha (private repos). */
async function resolveCommitViaApi(repo: string, ref: string, token: string): Promise<string> {
  const res = await github(
    `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
    { Accept: "application/vnd.github+json" },
    token,
  );
  if (res.status === 404) {
    throw new FetchError(`GitHub returned 404 for ${repo}@${ref} — check the repo/ref, and that your token can read the repo.`);
  }
  if (res.status === 401) throw new FetchError("GitHub rejected the token (401) — refresh GITHUB_TOKEN / `gh auth login`.");
  if (res.status === 403 || res.status === 429) throw new FetchError("GitHub API rate limit hit — try again in a few minutes.");
  if (!res.ok) throw new FetchError(`GitHub API error ${res.status} for ${repo}@${ref}`);
  const data: unknown = await res.json();
  if (data !== null && typeof data === "object" && "sha" in data && typeof data.sha === "string") return data.sha;
  throw new FetchError(`unexpected commit response from GitHub for ${repo}@${ref}`);
}

/**
 * A GitHub tarball's regular files, keyed by repo-relative path (the archive's
 * single top-level `<repo>-<sha>/` directory stripped). Entries that try to
 * climb out (`..`) are rejected.
 */
async function unpack(res: Response): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new FetchError(`repository archive is larger than ${MAX_ARCHIVE_BYTES} bytes`);
  const entries = await new Bun.Archive(bytes).files();
  const files = new Map<string, Uint8Array>();
  for (const [path, file] of entries) {
    const rel = path.split("/").slice(1).join("/");
    if (rel === "") continue;
    // `\` and `:` would be path separators / drive letters on Windows.
    if (/[\\:]/.test(rel) || rel.split("/").some((seg) => seg === ".." || seg === "")) {
      throw new FetchError(`refusing path traversal in repository archive: ${path}`);
    }
    files.set(rel, new Uint8Array(await file.arrayBuffer()));
  }
  return files;
}

/** A GitHub request with a timeout; network failures become a readable FetchError. */
async function github(url: string, headers: Record<string, string>, token: string | undefined): Promise<Response> {
  try {
    return await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: {
        "User-Agent": "mastro-connect",
        ...headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch (err) {
    const why = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "failed";
    throw new FetchError(`couldn't reach GitHub (${new URL(url).host}): request ${why} — are you online?`);
  }
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
