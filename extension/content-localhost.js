/**
 * Runs on the mastro bootstrap page (127.0.0.1 / localhost).
 *
 * Reads the inert session payload the receiver embedded, tells the page the
 * extension is present (so it doesn't show install instructions), and hands the
 * session to the background worker to begin capture.
 */
(function () {
  function readPayload() {
    const tag = document.getElementById("mastro-session");
    if (!tag) return null;
    try {
      return JSON.parse(tag.textContent || "");
    } catch {
      return null;
    }
  }

  function announcePresence() {
    // Inject a tiny page-context flag the bootstrap page checks.
    const s = document.createElement("script");
    s.textContent = "window.__mastroExtensionPresent = true;";
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  }

  function start() {
    const session = readPayload();
    if (!session || !session.sessionId) return;

    announcePresence();

    chrome.runtime.sendMessage(
      {
        action: "startAuthSession",
        session,
        receiverBaseUrl: location.origin,
      },
      function () {
        // Swallow "receiving end does not exist" during SW spin-up; the worker
        // is the source of truth and will open the app tab when ready.
        void chrome.runtime.lastError;
      },
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
