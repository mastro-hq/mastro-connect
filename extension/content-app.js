/**
 * Runs on every page (isolated world). For tabs the background worker has
 * marked as part of an active auth session, it:
 *   - injects page-bridge.js into the page's own JS world,
 *   - relays sanitized fetch/XHR/storage events to the background worker,
 *   - reports pageReady so completion checks can run.
 *
 * It does nothing unless the background worker confirms this tab belongs to a
 * session — unrelated browsing is never observed.
 */
(function () {
  let active = false;

  // Ask the worker whether this tab is part of an active session.
  chrome.runtime.sendMessage({ action: "isSessionTab" }, function (resp) {
    void chrome.runtime.lastError;
    if (resp && resp.active) activate();
  });

  function activate() {
    if (active) return;
    active = true;
    injectBridge();
    relayPageMessages();
    signalReady();
  }

  function injectBridge() {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("page-bridge.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  }

  function relayPageMessages() {
    window.addEventListener("message", function (event) {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.__mastro !== "bridgeEvent") return;
      chrome.runtime.sendMessage(
        { action: "bridgeEvent", detail: data.detail },
        function () {
          void chrome.runtime.lastError;
        },
      );
    });
  }

  function signalReady() {
    const send = () =>
      chrome.runtime.sendMessage({ action: "pageReady", url: location.href }, function () {
        void chrome.runtime.lastError;
      });
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", send, { once: true });
    } else {
      send();
    }
  }
})();
