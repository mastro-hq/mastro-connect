/**
 * mastro background service worker — the generic capture runtime.
 *
 * It interprets a provider's auth.manifest.json declaratively: no per-provider
 * code. One session at a time. Observations from cookies / webRequest headers /
 * page-bridge events are reduced into `state`; when the manifest's completion
 * predicate is satisfied, `state` is serialized via the manifest's templates
 * and POSTed to the loopback receiver.
 *
 * Safety: only tabs tied to the active session are observed; the capture is
 * submitted exactly once; the session is held in memory only.
 */

import { evaluateCompletion } from "./lib/completion.js";
import { renderFields } from "./lib/serialize.js";
import { extractCookies } from "./lib/cookies.js";
import { startProxyLoop } from "./lib/proxy.js";

// Long-poll the mastro browser-proxy server so `mastro <provider> <cmd>` can run
// requests through an authenticated tab (past Cloudflare). No-ops when no mastro
// command is running (the server simply isn't up).
startProxyLoop();

// Session/state shapes live in types.d.ts (MastroSession, MastroState, …),
// mirroring the @mastro/core contracts.

/** @type {MastroSession | null} */
let session = null;

/**
 * Last completed capture outcome, kept so the popup can show what happened even
 * after the in-memory session is cleared.
 * @type {{ providerId: string, displayName: string, ok: boolean, fields: string[], at: number, message: string } | null}
 */
let lastResult = null;

/** Snapshot of current state for the popup. */
function buildStatus() {
  return {
    busy: session !== null,
    provider: session ? { id: session.providerId, displayName: session.manifest.display_name } : null,
    captured: session ? Object.keys(session.state).filter((k) => !k.startsWith("__")) : [],
    last: lastResult,
  };
}

/**
 * Narrow the module-level `session` to a non-null, matching active session for
 * a given tab. Returns null if there's no active session or the tab is unrelated.
 * @param {number | undefined} tabId
 * @returns {MastroSession | null}
 */
function activeSessionForTab(tabId) {
  if (!session || session.submitted) return null;
  return tabId === session.appTabId ? session : null;
}

// -- message routing --------------------------------------------------------

chrome.runtime.onMessage.addListener(
  /**
   * @param {MastroMessage} msg
   * @param {chrome.runtime.MessageSender} sender
   * @param {(response: unknown) => void} sendResponse
   */
  (msg, sender, sendResponse) => {
    switch (msg?.action) {
      case "startAuthSession":
        startSession(msg.session, msg.receiverBaseUrl, sender?.tab?.id);
        sendResponse({ ok: true });
        return false;

      case "isSessionTab":
        sendResponse({ active: !!session && sender?.tab?.id === session.appTabId });
        return false;

      case "getStatus":
        sendResponse(buildStatus());
        return false;

      case "pageReady":
        if (session && sender?.tab?.id === session.appTabId) maybeComplete();
        sendResponse({ ok: true });
        return false;

      case "bridgeEvent": {
        const s = activeSessionForTab(sender?.tab?.id);
        if (s) {
          applyPageEvent(s, msg.detail);
          maybeComplete();
        }
        sendResponse({ ok: true });
        return false;
      }

      default:
        return false;
    }
  },
);

// -- session lifecycle ------------------------------------------------------

/**
 * @param {MastroSessionPayload} payload
 * @param {string} receiverBaseUrl
 * @param {number | undefined} bootstrapTabId
 */
async function startSession(payload, receiverBaseUrl, bootstrapTabId) {
  const manifest = payload.manifest;
  if (!manifest || !payload.launchUrl) return;

  session = {
    sessionId: payload.sessionId,
    providerId: payload.providerId,
    receiverBaseUrl,
    manifest,
    launchUrl: payload.launchUrl,
    appTabId: undefined,
    bootstrapTabId,
    state: { cookies: {}, headers: {}, storage: { local: {}, session: {} } },
    seenHeaders: new Set(),
    submitted: false,
  };

  await reportStatus("connected");

  if (manifest.launch.open_tab !== false) {
    const tab = await chrome.tabs.create({ url: payload.launchUrl, active: true });
    session.appTabId = tab.id;
  }
}

function endSession() {
  session = null;
}

// -- webRequest observation -------------------------------------------------

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const s = activeSessionForTab(details.tabId);
    if (!s) return;
    applyHeaderRules(s, "request", details.url, details.requestHeaders ?? []);
    maybeComplete();
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"],
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const s = activeSessionForTab(details.tabId);
    if (!s) return;
    applyHeaderRules(s, "response", details.url, details.responseHeaders ?? []);
    if (details.statusCode >= 200 && details.statusCode < 400) {
      (s.state.__authedResponses ??= []).push(details.url);
    }
    maybeComplete();
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"],
);

/**
 * @param {MastroSession} s
 * @param {"request" | "response"} source
 * @param {string} url
 * @param {chrome.webRequest.HttpHeader[]} headers
 */
function applyHeaderRules(s, source, url, headers) {
  const rules = (s.manifest.capture.headers ?? []).filter((r) => r.source === source);
  for (const rule of rules) {
    if (!urlMatches(url, rule.url_matches, rule.is_regex)) continue;
    const bucket = rule.save_as ?? "headers";
    const target = /** @type {Record<string, string>} */ (
      (s.state[bucket] ??= /** @type {Record<string, string>} */ ({}))
    );
    const wanted = new Set(rule.include_names.map((n) => n.toLowerCase()));
    for (const h of headers) {
      const name = (h.name ?? "").toLowerCase();
      if (wanted.has(name)) {
        target[name] = h.value ?? "";
        s.seenHeaders.add(name);
      }
    }
  }
}

// -- page-bridge events -----------------------------------------------------

/**
 * @param {MastroSession} s
 * @param {MastroBridgeEvent} detail
 */
function applyPageEvent(s, detail) {
  if (!detail) return;

  if (detail.type === "storage-snapshot") {
    for (const rule of s.manifest.capture.storage ?? []) {
      const src = rule.area === "session" ? detail.session : detail.local;
      const bucket = rule.save_as ?? `storage.${rule.area}`;
      const picked = rule.keys
        ? Object.fromEntries(rule.keys.filter((k) => k in src).map((k) => [k, src[k]]))
        : src;
      setPath(s.state, bucket, picked);
    }
    return;
  }

  // fetch-response | xhr-response
  const rules = (s.manifest.capture.page_events ?? []).filter((r) => r.source === detail.type);
  for (const rule of rules) {
    if (!urlMatches(detail.url, rule.url_matches, rule.is_regex)) continue;
    /** @type {unknown} */
    let value = detail.bodyText;
    if (rule.body_json_path) {
      try {
        value = jsonPath(JSON.parse(detail.bodyText), rule.body_json_path);
      } catch {
        value = undefined;
      }
    }
    if (value !== undefined) setPath(s.state, rule.save_as, value);
  }
}

// -- completion + capture ---------------------------------------------------

async function maybeComplete() {
  const s = session;
  if (!s || s.submitted) return;

  // Fold in cookies fresh on each check — they may not exist until after login.
  await refreshCookies(s);

  if (!evaluateCompletion(s.manifest.completion, s.state, s.seenHeaders)) return;

  s.submitted = true;
  const bundle = serialize(s);
  const ok = await postCapture(s, bundle);
  recordResult(s, bundle, ok);
  if (ok) {
    await reportStatus("captured");
    closeTabs(s);
  } else {
    await reportStatus("error", "failed to post capture to receiver");
  }
  endSession();
}

/**
 * Remember the outcome so the popup can show it after the session is cleared.
 * Records only which credential fields were captured — never their values.
 * @param {MastroSession} s
 * @param {{ credentials: Record<string, unknown> }} bundle
 * @param {boolean} ok
 */
function recordResult(s, bundle, ok) {
  lastResult = {
    providerId: s.providerId,
    displayName: s.manifest.display_name,
    ok,
    fields: Object.keys(bundle.credentials),
    at: Date.now(),
    message: ok ? "captured and sent to mastro" : "failed to post capture to mastro",
  };
}

/** @param {MastroSession} s */
async function refreshCookies(s) {
  for (const rule of s.manifest.capture.cookies ?? []) {
    const url = rule.url === "$launch.url" ? s.launchUrl : rule.url;
    const cookies = await extractCookies(url, rule.include_names_matching);
    const bucket = rule.save_as ?? "cookies";
    const existing = /** @type {Record<string, MastroCookie>} */ (s.state[bucket] ?? {});
    s.state[bucket] = { ...existing, ...cookies };
  }
}

/**
 * @param {MastroSession} s
 * @returns {{ credentials: Record<string, unknown> } & Record<string, unknown>} a capture bundle (capture-bundle/v1)
 */
function serialize(s) {
  const credentials = renderFields(s.manifest.serialization.fields, s.state);
  return {
    schema_version: "capture-bundle/v1",
    provider_id: s.providerId,
    captured_at: Math.floor(Date.now() / 1000),
    credentials,
    browser_context: {
      user_agent: navigator.userAgent,
      locale: navigator.language,
    },
    metadata: {
      method: "extension",
      observations_used: Object.keys(s.state).filter((k) => !k.startsWith("__")),
    },
  };
}

/**
 * @param {MastroSession} s
 * @param {object} bundle
 * @returns {Promise<boolean>}
 */
async function postCapture(s, bundle) {
  try {
    const res = await fetch(`${s.receiverBaseUrl}/api/browser-auth/captures/${s.sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundle),
    });
    const json = /** @type {{ ok?: boolean }} */ (await res.json().catch(() => ({})));
    return res.ok && json.ok !== false;
  } catch {
    return false;
  }
}

/**
 * @param {string} status
 * @param {string} [message]
 */
async function reportStatus(status, message = "") {
  const s = session;
  if (!s) return;
  try {
    await fetch(`${s.receiverBaseUrl}/api/browser-auth/client-status/${s.sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, message }),
    });
  } catch {
    /* receiver may already be gone */
  }
}

/** @param {MastroSession} s */
function closeTabs(s) {
  const ids = [s.appTabId, s.bootstrapTabId].filter(
    /** @returns {id is number} */ (id) => id != null,
  );
  if (ids.length) chrome.tabs.remove(ids).catch(() => {});
}

// -- small helpers ----------------------------------------------------------

/**
 * @param {string} url
 * @param {string} pattern
 * @param {boolean} [isRegex]
 * @returns {boolean}
 */
function urlMatches(url, pattern, isRegex) {
  if (!pattern) return true;
  return isRegex ? new RegExp(pattern).test(url) : url.includes(pattern);
}

/**
 * Assign `value` into `obj` at a dotted path, creating intermediate objects.
 * @param {Record<string, unknown>} obj
 * @param {string} path
 * @param {unknown} value
 */
function setPath(obj, path, value) {
  const parts = path.split(".");
  /** @type {Record<string, unknown>} */
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] ?? "";
    if (typeof cur[key] !== "object" || cur[key] === null) cur[key] = {};
    cur = /** @type {Record<string, unknown>} */ (cur[key]);
  }
  cur[parts[parts.length - 1] ?? ""] = value;
}

/** @param {unknown} obj @param {string} path @returns {unknown} */
function jsonPath(obj, path) {
  return path.split(".").reduce(
    /** @param {unknown} acc @param {string} key */
    (acc, key) =>
      acc == null || typeof acc !== "object"
        ? undefined
        : /** @type {Record<string, unknown>} */ (acc)[key],
    obj,
  );
}
