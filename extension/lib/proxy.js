/**
 * Browser-proxy runtime for the extension.
 *
 * Continuously long-polls the mastro proxy server (fixed loopback port). When a
 * request arrives, it runs the fetch INSIDE an authenticated tab on the target
 * origin — in the page's MAIN world — so the request carries that tab's solved
 * Cloudflare challenge + same-origin cookies. The service worker's own fetch
 * would be challenged, so we never use it for the proxied request.
 *
 * See docs/BROWSER-PROXY.md.
 */

const PROXY_PORT = 7878; // must match @mastro/core DEFAULT_PROXY_PORT
const POLL_BASE = `http://127.0.0.1:${PROXY_PORT}`;

let running = false;

/** Start the long-poll loop (idempotent). */
export function startProxyLoop() {
  if (running) return;
  running = true;
  loop();
}

async function loop() {
  while (running) {
    /** @type {ProxyRequest | null} */
    let request = null;
    try {
      const res = await fetch(`${POLL_BASE}/proxy/poll`);
      if (res.status === 204) continue; // no work this cycle
      if (!res.ok) {
        await sleep(2000);
        continue;
      }
      request = /** @type {ProxyRequest} */ (await res.json());
    } catch {
      // Server not up (no mastro command running) — back off and retry.
      await sleep(3000);
      continue;
    }
    if (request) await handleRequest(request);
  }
}

/** @param {ProxyRequest} request */
async function handleRequest(request) {
  /** @type {ProxyResponse} */
  let response;
  try {
    const tabId = await tabForOrigin(request.origin);
    response = await runFetchInTab(tabId, request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    response = { status: 0, headers: {}, bodyText: JSON.stringify({ mastroProxyError: message }) };
  }
  try {
    await fetch(`${POLL_BASE}/proxy/response/${request.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(response),
    });
  } catch {
    /* server gone; nothing to do */
  }
}

/**
 * Find an existing tab on `origin`, or open one and wait for it to load.
 * @param {string} origin
 * @returns {Promise<number>}
 */
async function tabForOrigin(origin) {
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  const ready = tabs.find((t) => t.id != null && t.status === "complete");
  if (ready && ready.id != null) return ready.id;
  if (tabs[0] && tabs[0].id != null) return waitForComplete(tabs[0].id);

  const opened = await chrome.tabs.create({ url: `${origin}/`, active: false });
  if (opened.id == null) throw new Error(`could not open a tab for ${origin}`);
  return waitForComplete(opened.id);
}

/** @param {number} tabId @returns {Promise<number>} */
function waitForComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("timed out waiting for the tab to load (Cloudflare challenge?)"));
    }, 30_000);
    /** @param {number} id @param {{ status?: string }} info */
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(tabId);
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

/**
 * Run the request's fetch in the tab's MAIN world (page context). Returns the
 * status, headers, and body text.
 * @param {number} tabId
 * @param {ProxyRequest} request
 * @returns {Promise<ProxyResponse>}
 */
async function runFetchInTab(tabId, request) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [{ url: request.url, method: request.method, headers: request.headers, body: request.body }],
    func: pageFetch,
  });
  const result = injection && injection.result;
  if (!result) throw new Error("page fetch returned no result");
  return /** @type {ProxyResponse} */ (result);
}

/**
 * Runs in the PAGE's MAIN world (serialized + injected). Same-origin, so it
 * carries the page's cookies and Cloudflare clearance. Returns a plain object.
 * @param {{ url: string, method: string, headers: Record<string,string>, body?: string }} req
 */
async function pageFetch(req) {
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      credentials: "include",
    });
    /** @type {Record<string, string>} */
    const headers = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const bodyText = await res.text();
    return { status: res.status, headers, bodyText };
  } catch (e) {
    return { status: 0, headers: {}, bodyText: JSON.stringify({ pageFetchError: String(e) }) };
  }
}

function sleep(/** @type {number} */ ms) {
  return new Promise((r) => setTimeout(r, ms));
}
