/**
 * Read cookies for a URL via chrome.cookies (can see HttpOnly cookies the page
 * JS can't), keeping only those whose name matches one of the given regexes.
 *
 * @param {string} url
 * @param {string[]} includeNamesMatching   regex sources
 * @returns {Promise<Record<string, MastroCookie>>}
 */
export async function extractCookies(url, includeNamesMatching) {
  const patterns = (includeNamesMatching || []).map((p) => new RegExp(p));
  const all = await chrome.cookies.getAll({ url });
  /** @type {Record<string, MastroCookie>} */
  const out = {};
  for (const c of all) {
    if (patterns.length === 0 || patterns.some((re) => re.test(c.name))) {
      out[c.name] = { value: c.value, domain: c.domain };
    }
  }
  return out;
}
