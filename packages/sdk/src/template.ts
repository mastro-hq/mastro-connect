/**
 * Template resolution for x-mastro-* strings.
 *
 * Profiles use `${scope.path}` placeholders that resolve against a context,
 * typically `{ auth: <credential fields>, args: <cli args> }`. A string that is
 * exactly one placeholder preserves the resolved value's type (so a body field
 * can be a number/array/object); mixed strings interpolate to text.
 */

export type TemplateContext = Record<string, unknown>;

const WHOLE = /^\$\{([^}]+)\}$/;
const PART = /\$\{([^}]+)\}/g;

export class MissingTemplateValue extends Error {
  constructor(public readonly expr: string) {
    super(`template value "${expr}" resolved to undefined`);
    this.name = "MissingTemplateValue";
  }
}

/** Resolve a single template string. Preserves type for whole-placeholder strings. */
export function renderTemplate(
  template: string,
  ctx: TemplateContext,
  { strict = true }: { strict?: boolean } = {},
): unknown {
  const whole = template.match(WHOLE);
  if (whole) {
    const value = lookup(whole[1]!.trim(), ctx);
    if (value === undefined && strict) throw new MissingTemplateValue(whole[1]!.trim());
    return value;
  }
  return template.replace(PART, (_, expr: string) => {
    const value = lookup(expr.trim(), ctx);
    if (value === undefined && strict) throw new MissingTemplateValue(expr.trim());
    return value == null ? "" : String(value);
  });
}

/** Render every string in an object tree (used for request bodies). */
export function renderDeep(value: unknown, ctx: TemplateContext, opts?: { strict?: boolean }): unknown {
  if (typeof value === "string") return renderTemplate(value, ctx, opts);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, ctx, opts));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, renderDeep(v, ctx, opts)]),
    );
  }
  return value;
}

/**
 * Render a template that is expected to produce a string (a URL path, a header
 * value). Coerces the resolved value to a string so call sites don't need a
 * cast; throws via `renderTemplate` if a required placeholder is missing.
 */
export function renderTemplateString(
  template: string,
  ctx: TemplateContext,
  opts?: { strict?: boolean },
): string {
  const value = renderTemplate(template, ctx, opts);
  return value == null ? "" : String(value);
}

/** Render a map of string templates to strings (headers, query params). */
export function renderStringMap(
  map: Record<string, string>,
  ctx: TemplateContext,
  opts?: { strict?: boolean },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    const rendered = renderTemplate(v, ctx, opts);
    if (rendered != null) out[k] = String(rendered);
  }
  return out;
}

function lookup(expr: string, ctx: TemplateContext): unknown {
  // `${path|fallback}` — use the literal fallback when the path is empty/missing.
  const pipe = expr.indexOf("|");
  const path = pipe === -1 ? expr : expr.slice(0, pipe);
  const fallback = pipe === -1 ? undefined : expr.slice(pipe + 1);

  const value = path.split(".").reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, ctx);

  // A leaf that resolves to a zero-arg function is a generator (e.g. `${uuid}`,
  // `${now}`) — call it so each use produces a fresh value.
  const resolved = typeof value === "function" ? (value as () => unknown)() : value;
  if ((resolved === undefined || resolved === "") && fallback !== undefined) return fallback;
  return resolved;
}
