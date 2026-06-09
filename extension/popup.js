/**
 * Popup UI — polls the background worker for capture status and renders it.
 * Read-only: it never triggers a capture (that's `mastro login` from the CLI).
 */
const dot = /** @type {HTMLElement} */ (document.getElementById("dot"));
const stateEl = /** @type {HTMLElement} */ (document.getElementById("state"));
const detailEl = /** @type {HTMLElement} */ (document.getElementById("detail"));

/** @param {"idle"|"busy"|"ok"|"err"} kind */
function setDot(kind) {
  dot.className = `dot ${kind}`;
}

function render(/** @type {any} */ status) {
  if (status?.busy && status.provider) {
    setDot("busy");
    stateEl.textContent = `Capturing ${status.provider.displayName}…`;
    const got = (status.captured ?? []).filter((/** @type {string} */ k) => k !== "headers" && k !== "storage");
    detailEl.textContent = got.length
      ? `Observed so far: ${got.join(", ")}. Finish logging in to complete.`
      : "Waiting for you to log in in the opened tab.";
    return;
  }

  const last = status?.last;
  if (last) {
    setDot(last.ok ? "ok" : "err");
    stateEl.textContent = last.ok
      ? `Captured ${last.displayName}`
      : `Capture failed (${last.displayName})`;
    const when = relativeTime(last.at);
    detailEl.textContent = last.ok
      ? `Sent ${last.fields.join(", ")} to mastro · ${when}.`
      : `${last.message} · ${when}.`;
    return;
  }

  setDot("idle");
  stateEl.textContent = "Idle";
  detailEl.textContent = "No capture in progress.";
}

function relativeTime(/** @type {number} */ ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

function poll() {
  chrome.runtime.sendMessage({ action: "getStatus" }, (status) => {
    if (chrome.runtime.lastError) {
      setDot("err");
      stateEl.textContent = "Background worker unavailable";
      detailEl.textContent = "Try reloading the extension.";
      return;
    }
    render(status);
  });
}

poll();
setInterval(poll, 1000);
