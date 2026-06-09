/** Redaction helpers so tokens/cookies never reach logs or summaries. */

const MASK = "••••redacted••••";

/**
 * Return a deep copy of `value` with any key listed in `fields` masked.
 * Matching is case-insensitive on the leaf key name.
 */
export function redact<T>(value: T, fields: string[]): T {
  if (fields.length === 0) return value;
  const lower = new Set(fields.map((f) => f.toLowerCase()));
  return walk(value, lower) as T;
}

function walk(value: unknown, fields: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => walk(v, fields));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = fields.has(k.toLowerCase()) ? MASK : walk(v, fields);
    }
    return out;
  }
  return value;
}
