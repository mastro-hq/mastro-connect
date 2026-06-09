/**
 * Render a manifest's `serialization.fields` map into the capture bundle's
 * credential object.
 *
 * Each value is a template string. A value that is exactly one placeholder
 * ("${state.token}") resolves to the raw value (preserving objects/arrays).
 * Mixed strings interpolate to text. A few helper accessors are supported:
 *
 *   ${cookies.<name>.value}     a captured cookie's value
 *   ${cookies.as_header}        all captured cookies as a "k=v; k=v" header
 *   ${state.<path>}             any accumulated state path
 *   ${literal:true}             a literal (true/false/number/string)
 */
/**
 * @param {Record<string, string>} fields
 * @param {MastroState} state
 * @returns {Record<string, unknown>}
 */
export function renderFields(fields, state) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, template] of Object.entries(fields)) {
    out[key] = renderValue(template, state);
  }
  return out;
}

const WHOLE = /^\$\{([^}]+)\}$/;
const PART = /\$\{([^}]+)\}/g;

/**
 * @param {string} template
 * @param {MastroState} state
 * @returns {unknown}
 */
function renderValue(template, state) {
  if (typeof template !== "string") return template;

  const whole = template.match(WHOLE);
  if (whole && whole[1] !== undefined) return resolve(whole[1].trim(), state); // preserve type

  return template.replace(PART, (/** @type {string} */ _, /** @type {string} */ expr) => {
    const v = resolve(expr.trim(), state);
    return v == null ? "" : String(v);
  });
}

/**
 * @param {string} expr
 * @param {MastroState} state
 * @returns {unknown}
 */
function resolve(expr, state) {
  if (expr.startsWith("literal:")) return parseLiteral(expr.slice("literal:".length));

  if (expr === "cookies.as_header") {
    return Object.entries(state.cookies || {})
      .map(([name, c]) => `${name}=${c.value}`)
      .join("; ");
  }

  // cookies.<name>.value  →  state.cookies[name].value
  return getPath(state, expr);
}

/** @param {string} s @returns {string | number | boolean | null} */
function parseLiteral(s) {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/** @param {unknown} obj @param {string} path @returns {unknown} */
function getPath(obj, path) {
  return path.split(".").reduce(
    /** @param {unknown} acc @param {string} key */
    (acc, key) =>
      acc == null || typeof acc !== "object"
        ? undefined
        : /** @type {Record<string, unknown>} */ (acc)[key],
    obj,
  );
}
