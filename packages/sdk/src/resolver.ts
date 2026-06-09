/**
 * Taxonomy resolver — turns a parameter's `x-mastro-resolve` into a
 * label↔wire-value index by fetching the referenced metadata operation.
 *
 * Depop's `sizes`/`brands`/`categories` aren't a static enum; their valid
 * values come from another endpoint (e.g. getSizeFilters returns a tree of
 * {composite_id, name}). This resolver fetches that once (cached), walks the
 * value_path / label_path, and lets the connector map whatever the user passes
 * (a wire id OR a human label) to the wire value the API expects.
 */
import type { MastroResolve } from "@mastro/core";

import { JsonCache } from "./cache.ts";

export interface TaxonomyEntry {
  /** The value the API expects on the wire. */
  value: string;
  /** The human-readable label (for `--help` / listing). */
  label: string;
}

/** Fetches the raw JSON body of a metadata operation by operationId. */
export type MetadataFetcher = (operationId: string) => Promise<unknown>;

/** Loads a bundled reference JSON file by its relative path (provider dir). */
export type FileLoader = (relativePath: string) => unknown;

const FILE_PREFIX = "file:";

export class Resolver {
  constructor(
    private readonly cache: JsonCache,
    private readonly fetcher: MetadataFetcher,
    /** Loads `file:` sources; required if any resolve uses one. */
    private readonly fileLoader?: FileLoader,
  ) {}

  /** Build (or load cached) the taxonomy entries for an endpoint-backed resolve. */
  async load(spec: MastroResolve): Promise<TaxonomyEntry[]> {
    const cacheKey = `resolve.${spec.from}`;
    const cached = this.cache.get<TaxonomyEntry[]>(cacheKey);
    if (cached) return cached;

    const body = await this.fetcher(spec.from);
    const entries = this.toEntries(body, spec);
    this.cache.set(cacheKey, entries, spec.cache_ttl ?? 86_400);
    return entries;
  }

  /**
   * Map a user-supplied value to the wire value. Accepts the wire value itself
   * or a case-insensitive label match; returns the input unchanged if no match
   * (so unknown-but-valid wire ids still pass through).
   *
   * Sources: an operationId (live, cached) or `file:<path>` (bundled JSON).
   * A keyed file source (`keyed: true`) looks the input up by object key and
   * returns the entry's `value_path` field — used for two-level taxonomies like
   * `(department/product_type) → size_set`.
   */
  async resolveValue(spec: MastroResolve, input: string): Promise<string> {
    if (spec.from.startsWith(FILE_PREFIX)) return this.resolveFromFile(spec, input);

    const entries = await this.load(spec);
    return matchEntry(entries, input);
  }

  /**
   * Keyed file lookup with an explicit key (computed by the caller from
   * `key_template`). Returns the entry's `value_path` field, or "" if absent.
   */
  lookupKeyed(spec: MastroResolve, key: string): string {
    if (!this.fileLoader) throw new Error(`no file loader configured for "${spec.from}"`);
    const data = this.fileLoader(spec.from.slice(FILE_PREFIX.length));
    const entry = data && typeof data === "object" ? (data as Record<string, unknown>)[key] : undefined;
    if (entry == null) return "";
    const value = spec.value_path ? firstOf(extractPath(entry, spec.value_path)) : entry;
    return value == null ? "" : String(value);
  }

  private resolveFromFile(spec: MastroResolve, input: string): string {
    if (!this.fileLoader) throw new Error(`no file loader configured for "${spec.from}"`);
    const data = this.fileLoader(spec.from.slice(FILE_PREFIX.length));

    if (spec.keyed) return this.lookupKeyed(spec, input);
    return matchEntry(this.toEntries(data, spec), input);
  }

  private toEntries(body: unknown, spec: MastroResolve): TaxonomyEntry[] {
    const values = spec.value_path ? extractPath(body, spec.value_path) : [];
    const labels = spec.label_path ? extractPath(body, spec.label_path) : [];
    return values.map((value, i) => ({ value: String(value), label: String(labels[i] ?? value) }));
  }
}

/** Match an input against entries: by wire value, then case-insensitive label. */
function matchEntry(entries: TaxonomyEntry[], input: string): string {
  const byValue = entries.find((e) => e.value === input);
  if (byValue) return byValue.value;
  const lc = input.toLowerCase();
  const byLabel = entries.find((e) => e.label.toLowerCase() === lc);
  return byLabel ? byLabel.value : input;
}

function firstOf(values: unknown[]): unknown {
  return values.length > 0 ? values[0] : undefined;
}

/**
 * Extract all values at a dotted path with `[]` array-wildcard segments.
 *
 *   "objects[].id"      → every object's id
 *   "[].composite_id"   → composite_id of each top-level array element
 *   "categoryFilters[].children[].id" → deep wildcard
 *
 * Returns a flat array of the matched leaf values.
 */
export function extractPath(root: unknown, path: string): unknown[] {
  const segments = path.split(".").filter((s) => s.length > 0);
  let frontier: unknown[] = [root];

  for (const seg of segments) {
    const isWildcard = seg.endsWith("[]");
    const key = isWildcard ? seg.slice(0, -2) : seg;

    const next: unknown[] = [];
    for (const node of frontier) {
      const child = key === "" ? node : descend(node, key);
      if (isWildcard) {
        if (Array.isArray(child)) next.push(...child);
      } else if (child !== undefined) {
        next.push(child);
      }
    }
    frontier = next;
  }
  return frontier;
}

function descend(node: unknown, key: string): unknown {
  if (node == null || typeof node !== "object") return undefined;
  return (node as Record<string, unknown>)[key];
}
