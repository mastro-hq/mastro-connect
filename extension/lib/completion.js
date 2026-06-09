/**
 * Evaluate a manifest completion rule against accumulated capture state.
 * Mirrors the CompletionRule type in @mastro/core.
 *
 * @param {MastroCompletionRule} rule
 * @param {MastroState} state
 * @param {Set<string>} seenHeaders   lower-cased header names observed so far
 * @returns {boolean}
 */
export function evaluateCompletion(rule, state, seenHeaders) {
  if (!rule || typeof rule !== "object") return false;

  if ("all" in rule) return rule.all.every((r) => evaluateCompletion(r, state, seenHeaders));
  if ("any" in rule) return rule.any.some((r) => evaluateCompletion(r, state, seenHeaders));
  if ("not" in rule) return !evaluateCompletion(rule.not, state, seenHeaders);

  if ("field_present" in rule) return truthy(getPath(state, rule.field_present));

  if ("cookie_present" in rule) {
    return !!(state.cookies && rule.cookie_present in state.cookies);
  }
  if ("cookie_name_prefix_present" in rule) {
    return Object.keys(state.cookies || {}).some((n) =>
      n.startsWith(rule.cookie_name_prefix_present),
    );
  }
  if ("header_seen" in rule) return seenHeaders.has(rule.header_seen.toLowerCase());

  if ("storage_key_present" in rule) {
    const { area, key } = rule.storage_key_present.includes(".")
      ? splitArea(rule.storage_key_present)
      : { area: "local", key: rule.storage_key_present };
    const bucket = area === "session" ? state.storage.session : state.storage.local;
    return key in bucket;
  }

  if ("authenticated_response_seen" in rule) {
    return (state.__authedResponses || []).some((u) =>
      u.includes(rule.authenticated_response_seen),
    );
  }

  return false;
}

/** @param {string} spec @returns {{ area: string, key: string }} */
function splitArea(spec) {
  const [area, ...rest] = spec.split(".");
  return { area: area ?? "local", key: rest.join(".") };
}

/** @param {unknown} v @returns {boolean} */
function truthy(v) {
  if (v == null) return false;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
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
