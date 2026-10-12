/**
 * Which origins the browser proxy may act on.
 *
 * The proxy runs credentialed fetches and storage writes inside the user's
 * tabs, so it must not do that for an arbitrary origin just because something
 * on the loopback port asked. An origin becomes allowed when the user completes
 * a `mastro login` whose manifest names it (its `launch.expected_origins` and
 * `permissions.host_permissions`) — the same sites the user just consented to.
 * Persisted in chrome.storage.local so it survives service-worker restarts.
 */

const KEY = "mastroAllowedOrigins";

/**
 * Add a completed login's origins to the allowlist.
 * @param {MastroAuthManifest} manifest
 */
export async function rememberOrigins(manifest) {
  const origins = new Set(await allowedOrigins());
  for (const origin of manifest.launch.expected_origins) addOrigin(origins, origin);
  for (const pattern of manifest.permissions.host_permissions) addOrigin(origins, pattern.replace(/\/\*$/, "/"));
  await chrome.storage.local.set({ [KEY]: [...origins] });
}

/** @returns {Promise<string[]>} */
export async function allowedOrigins() {
  const stored = await chrome.storage.local.get(KEY);
  const value = stored[KEY];
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

/**
 * The origin of `url` if it's https (or loopback http) and on the allowlist.
 * @param {string} url
 * @param {string[]} allowed
 * @returns {boolean}
 */
export function isAllowedUrl(url, allowed) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return false;
  return allowed.includes(parsed.origin);
}

/** @param {Set<string>} into @param {string} url */
function addOrigin(into, url) {
  try {
    const parsed = new URL(url);
    // A wildcard host (https://*.example.com/*) can't be a concrete origin; skip it.
    if (!parsed.hostname.includes("*")) into.add(parsed.origin);
  } catch {
    // not a URL — ignore
  }
}
