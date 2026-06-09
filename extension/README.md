# mastro · connect — capture extension

A **generic** MV3 extension. It interprets whatever `auth.manifest.json` the
local `mastro` broker hands it — there is no per-provider code here.

## Install (unpacked)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. **Load unpacked** → select this `extension/` folder

## Files

| File                   | Role |
| ---------------------- | ---- |
| `manifest.json`        | MV3 metadata + permissions. |
| `content-localhost.js` | Runs on the mastro bootstrap page; reads the session payload and starts the worker. |
| `content-app.js`       | Runs on the target site; injects the page bridge and relays events — only for tabs in an active session. |
| `page-bridge.js`       | Runs in the page's JS world; observes fetch/XHR responses and storage (size-capped). |
| `background.js`        | The generic runtime: observes cookies/headers/page-events, evaluates the manifest's completion rule, serializes + posts the capture. |
| `lib/completion.js`    | Pure evaluator for the completion predicate tree. |
| `lib/serialize.js`     | Pure renderer for the serialization templates. |
| `lib/cookies.js`       | Reads HttpOnly cookies via `chrome.cookies`. |

## Permissions note

MV3 requires `host_permissions` and `webRequest` to be declared **statically**
at install time — they can't be narrowed per provider at runtime. So the
extension declares `<all_urls>`, but the background worker **only ever observes
tabs tied to an active capture session**; ordinary browsing is never touched,
and the session lives in memory and expires fast. The per-provider *narrowing*
of what to capture happens in the manifest the broker sends.

## Safety

- One session at a time, in memory only.
- Capture is posted exactly once, only to the `127.0.0.1` receiver that started it.
- Response bodies are capped at 64 KB before postback.
- Tokens/cookies are redacted in the CLI's logs (see `@mastro/core`'s `redact`).
