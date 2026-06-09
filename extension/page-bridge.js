/**
 * Runs in the PAGE's JavaScript world (not the isolated content-script world).
 *
 * Content scripts can't see the page's own `window.fetch` / `XMLHttpRequest`
 * results, so this bridge monkey-patches them, captures response bodies (size-
 * capped), snapshots storage, and posts sanitized events back to the content
 * script via window.postMessage. The content script relays them to the worker.
 */
(function () {
  const MAX_BODY = 64 * 1024; // never ship more than 64 KB of a response body

  /** @param {MastroBridgeEvent} detail */
  function emit(detail) {
    window.postMessage({ __mastro: "bridgeEvent", detail }, window.location.origin);
  }

  /** @param {unknown} text @returns {string} */
  function clip(text) {
    if (typeof text !== "string") return "";
    return text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text;
  }

  /** @param {RequestInfo | URL} input @returns {string} */
  function urlOf(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input.url; // Request
  }

  // -- fetch ----------------------------------------------------------------
  const origFetch = window.fetch;
  window.fetch = function (/** @type {RequestInfo | URL} */ input, /** @type {RequestInit=} */ init) {
    const url = urlOf(input);
    return origFetch.call(this, input, init).then((res) => {
      res
        .clone()
        .text()
        .then((body) => emit({ type: "fetch-response", url, status: res.status, bodyText: clip(body) }))
        .catch(() => {
          /* opaque/streaming responses can't be read; ignore */
        });
      return res;
    });
  };

  // -- XHR ------------------------------------------------------------------
  // Track each request's URL out-of-band rather than augmenting XMLHttpRequest.
  /** @type {WeakMap<XMLHttpRequest, string>} */
  const xhrUrls = new WeakMap();
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    /** @type {string} */ method,
    /** @type {string | URL} */ url,
    /** @type {unknown[]} */ ...rest
  ) {
    xhrUrls.set(this, typeof url === "string" ? url : url.href);
    // @ts-expect-error — forwarding the native variadic signature verbatim
    return open.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (/** @type {Document | XMLHttpRequestBodyInit | null=} */ body) {
    this.addEventListener("load", () => {
      let text = "";
      try {
        text = typeof this.responseText === "string" ? this.responseText : "";
      } catch {
        /* responseType != text */
      }
      emit({
        type: "xhr-response",
        url: xhrUrls.get(this) ?? "",
        status: this.status,
        bodyText: clip(text),
      });
    });
    return send.call(this, body ?? null);
  };

  // -- storage snapshot -----------------------------------------------------
  /** @param {Storage} area @returns {Record<string, string>} */
  function snapshot(area) {
    /** @type {Record<string, string>} */
    const out = {};
    try {
      for (let i = 0; i < area.length; i++) {
        const key = area.key(i);
        if (key !== null) out[key] = area.getItem(key) ?? "";
      }
    } catch {
      /* storage access can throw on some origins */
    }
    return out;
  }

  function emitStorage() {
    emit({
      type: "storage-snapshot",
      local: snapshot(window.localStorage),
      session: snapshot(window.sessionStorage),
    });
  }

  emitStorage();
  // Re-snapshot shortly after load — SPAs often write auth context post-init.
  setTimeout(emitStorage, 1500);
})();
