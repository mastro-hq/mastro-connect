/**
 * The bootstrap page served at /browser-auth/start/<sessionId>.
 *
 * It carries the session payload to the extension in an inert <script
 * type="application/json"> tag (content-localhost.js reads it), shows live
 * status, and degrades gracefully when the extension isn't installed.
 */
import type { SessionPayload } from "./receiver.ts";

export function renderBootstrapPage(session: SessionPayload): string {
  // Inert JSON — never executed, only read by the content script. Escape the
  // closing-tag sequence so a hostile field can't break out of the script.
  const payloadJson = JSON.stringify(session).replace(/</g, "\\u003c");

  return /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>mastro · connect ${escapeHtml(session.displayName)}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
      max-width: 540px; margin: 12vh auto; padding: 0 24px; }
    h1 { font-size: 1.4rem; margin-bottom: .25rem; }
    .muted { opacity: .65; }
    .card { border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
      border-radius: 12px; padding: 18px 20px; margin-top: 22px; }
    .status { display: flex; align-items: center; gap: 10px; font-weight: 600; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #f5a623;
      animation: pulse 1.4s ease-in-out infinite; }
    .dot.ok { background: #2ecc71; animation: none; }
    .dot.err { background: #e74c3c; animation: none; }
    code { background: color-mix(in srgb, currentColor 10%, transparent);
      padding: 1px 6px; border-radius: 5px; }
    ol { padding-left: 1.2rem; }
    @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
  </style>
</head>
<body>
  <h1>Connecting ${escapeHtml(session.displayName)}</h1>
  <p class="muted">mastro is capturing your ${escapeHtml(session.displayName)} session.</p>

  <div class="card">
    <div class="status"><span class="dot" id="dot"></span><span id="status">Waiting for the mastro extension…</span></div>
    <p class="muted" id="hint">Keep this tab open. A ${escapeHtml(session.displayName)} tab will open next — log in if asked.</p>
  </div>

  <div class="card" id="install" hidden>
    <strong>Extension not detected.</strong>
    <ol>
      <li>Open <code>chrome://extensions</code></li>
      <li>Enable <em>Developer mode</em> (top-right)</li>
      <li><em>Load unpacked</em> → select the <code>extension/</code> folder</li>
      <li>Reload this page</li>
    </ol>
  </div>

  <script type="application/json" id="mastro-session">${payloadJson}</script>
  <script>
    // If the extension is present, content-localhost.js sets this flag.
    setTimeout(function () {
      if (!window.__mastroExtensionPresent) {
        document.getElementById('install').hidden = false;
        document.getElementById('status').textContent = 'mastro extension not found';
        document.getElementById('dot').className = 'dot err';
      }
    }, 1500);
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
