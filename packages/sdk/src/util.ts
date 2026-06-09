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

/** A promise that resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
