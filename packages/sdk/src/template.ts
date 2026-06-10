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
/** An innermost placeholder: `${...}` whose body has no nested `${`. */
const INNER = /\$\{([^${}]+)\}/;

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
  template = resolveNested(template, ctx, strict);

  const whole = template.match(WHOLE);
  if (whole) {
    let expr = whole[1]!.trim();
    // A leading `<mod>:` selects a value transform. `num:` casts to a JS number
    // (a body field serializes as a JSON number, not a string — Depop wants
    // numeric lat/lng, address id, variant_set). `unquote:` strips one layer of
    // surrounding double-quotes from a string (LinkedIn stores JSESSIONID as
    // `"ajax:123"` but its csrf-token header wants the bare `ajax:123`).
    let cast: "number" | "unquote" | undefined;
    if (expr.startsWith("num:")) {
      cast = "number";
      expr = expr.slice(4).trim();
    } else if (expr.startsWith("unquote:")) {
      cast = "unquote";
      expr = expr.slice(8).trim();
    }
    const value = lookup(expr, ctx);
    if (value === undefined && strict) throw new MissingTemplateValue(expr);
    if (cast === "number" && value != null && value !== "") {
      const n = Number(value);
      if (!Number.isNaN(n)) return n;
    }
    if (cast === "unquote" && typeof value === "string") {
      return value.replace(/^"(.*)"$/s, "$1");
    }
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
    // Render both keys and values so a body can have a dynamic key, e.g.
    // `{ "${args.variant}": 1 }` → `{ "4": 1 }` (Depop's `variants` map). An
    // entry whose key renders empty (e.g. a one-size item with no variant) is
    // dropped, so `{ "${args.variant}": 1 }` becomes `{}` rather than `{ "": 1 }`.
    return Object.fromEntries(
      Object.entries(value)
        .map(([k, v]) => [renderTemplateString(k, ctx, opts), renderDeep(v, ctx, opts)] as const)
        .filter(([k]) => k !== ""),
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

/**
 * Resolve nested placeholders inside-out, e.g. `${steps.slots.${index}}` with
 * index=0 → `${steps.slots.0}`. Repeatedly substitutes the innermost
 * placeholder (one with no `${` in its body) until only top-level placeholders
 * remain, which the caller then resolves normally. A string with no nesting is
 * returned unchanged after one cheap scan.
 */
function resolveNested(template: string, ctx: TemplateContext, strict: boolean): string {
  // Only the body of an *outer* placeholder can contain a nested `${`. If no
  // placeholder body contains `${`, there's nothing to pre-resolve.
  while (/\$\{[^}]*\$\{/.test(template)) {
    const before = template;
    template = template.replace(INNER, (_, expr: string) => {
      const value = lookup(expr.trim(), ctx);
      if (value === undefined && strict) throw new MissingTemplateValue(expr.trim());
      return value == null ? "" : String(value);
    });
    if (template === before) break; // no progress — avoid an infinite loop
  }
  return template;
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
  if ((resolved === undefined || resolved === "") && fallback !== undefined) {
    // `[]` / `{}` fallbacks yield real empty JSON containers (so an omitted
    // repeatable flag like --age becomes `[]`, not the literal string "[]").
    if (fallback === "[]") return [];
    if (fallback === "{}") return {};
    return fallback;
  }
  return resolved;
}
