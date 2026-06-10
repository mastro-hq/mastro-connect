/**
 * Small shared helpers used across the SDK's replay paths.
 *
 * These used to be copy-pasted (and quietly drifting) in both connector.ts and
 * workflow.ts. Keeping one copy means an `x-mastro-result` path behaves
 * identically whether it's read by a single `call()` or a workflow step.
 */

/**
 * Walk a dotted path into a value, returning `undefined` if any segment is
 * absent or a non-object is hit. Empty segments (leading/trailing/`..`) are
 * skipped, so `".create.slug"` and `"create.slug"` resolve the same.
 */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (seg === "") continue;
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Parse text as JSON, falling back to the raw string if it isn't JSON. */
export function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the HTML entities that occur in practice plus all numeric ones. */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/g, (whole, hex, dec, named) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (dec) return String.fromCodePoint(parseInt(dec, 10));
    return NAMED_ENTITIES[named] ?? whole;
  });
}

const META_REFRESH =
  /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']\s*\d+\s*;\s*url=(?:'([^']*)'|([^"'>\s]+))/i;

/**
 * The target of an HTML meta-refresh interstitial, or undefined if the body
 * isn't one. Bot walls (Akamai bm-verify) answer flagged requests with a tiny
 * page that refreshes to the same URL plus a one-time token — following it
 * yields the real response. Possibly relative; resolve against the request URL.
 */
export function metaRefreshUrl(body: string): string | undefined {
  // An interstitial is a stub page; never scan a full (multi-MB) document.
  if (body.length > 16_384) return undefined;
  const match = META_REFRESH.exec(body);
  const url = match?.[1] ?? match?.[2];
  return url ? decodeEntities(url) : undefined;
}

/** A promise that resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
