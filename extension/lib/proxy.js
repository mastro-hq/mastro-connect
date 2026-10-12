/**
 * Browser-proxy runtime for the extension.
 *
 * Continuously long-polls the mastro proxy server (fixed loopback port). When a
 * job arrives, it runs INSIDE an authenticated tab on the job's origin — in the
 * page's MAIN world:
 *   - `fetch`: the request carries that tab's solved Cloudflare challenge +
 *     cookies. The service worker's own fetch would be challenged, so we never
 *     use it for the proxied request.
 *   - `handoff`: write localStorage, then open the URL in that tab and focus it
 *     — the CLI staged something (a cart) a human must finish (pay).
 *
 * Jobs only run for origins the user has logged in to through mastro (see
 * allowlist.js): whatever answers on the loopback port can't point the
 * extension at an arbitrary site.
 *
 * See docs/BROWSER-PROXY.md.
 */
import { allowedOrigins, isAllowedUrl } from "./allowlist.js";

const PROXY_PORT = 7878; // must match @mastro/core DEFAULT_PROXY_PORT
const POLL_BASE = `http://127.0.0.1:${PROXY_PORT}`;
/** Job protocol this extension speaks; the server refuses jobs a client is too old for. */
const PROTOCOL_VERSION = 2;

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
      const res = await fetch(`${POLL_BASE}/proxy/poll?v=${PROTOCOL_VERSION}`);
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
    await assertAllowed(request);
    const tabId = await tabForOrigin(request.origin);
    response =
      request.kind === "handoff" ? await handoffInTab(tabId, request) : await runFetchInTab(tabId, request);
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
 * Refuse a job whose tab origin or target URL the user hasn't logged in to
 * through mastro. A handoff must also open a page on its own origin.
 * @param {ProxyRequest} request
 */
async function assertAllowed(request) {
  const allowed = await allowedOrigins();
  for (const url of [request.origin, request.url]) {
    if (!isAllowedUrl(url, allowed)) {
      throw new Error(
        `refusing ${new URL(url).origin}: mastro only acts on sites you've logged in to with \`mastro login <provider>\``,
      );
    }
  }
  if (request.kind === "handoff" && new URL(request.url).origin !== new URL(request.origin).origin) {
    throw new Error("refusing a handoff to a page outside its own origin");
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
 * Hand off to the user: write the job's localStorage entries through a tab on
 * the origin (storage is per-origin, so any tab there works), then open the
 * job's URL in a NEW tab and bring it to the front — never navigating away
 * from a page the user has open.
 * @param {number} tabId
 * @param {ProxyHandoffRequest} request
 * @returns {Promise<ProxyResponse>}
 */
async function handoffInTab(tabId, request) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [request.local_storage],
    func: writeLocalStorage,
  });
  if (!injection || injection.result !== true) throw new Error("could not write the page's storage for the handoff");
  const tab = await chrome.tabs.create({ url: request.url, active: true });
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  return { status: 200, headers: {}, bodyText: JSON.stringify({ ok: true }) };
}

/**
 * Runs in the PAGE's MAIN world (serialized + injected). True once every entry
 * is written.
 * @param {Record<string, string>} entries
 * @returns {boolean}
 */
function writeLocalStorage(entries) {
  for (const [key, value] of Object.entries(entries)) window.localStorage.setItem(key, value);
  return true;
}

/**
 * Run the request's fetch in the tab's MAIN world (page context). Returns the
 * status, headers, and body text.
 * @param {number} tabId
 * @param {ProxyFetchRequest} request
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
