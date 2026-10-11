# Browser-proxy transport

## Why

Some apps only answer requests that come from a real browser session — a
client outside the browser gets an interstitial page (`403 "Just a moment"`, a
302 back to the same URL) even with the right cookies.

The user already has that browser session: they're logged in, in their own
tab. So instead of replaying the request from outside, mastro **runs it inside
that tab's page context** — exactly where the app's own frontend makes the same
call — and relays the response back to the CLI. mastro never solves challenges
or CAPTCHAs itself; if the user's tab isn't through, neither is mastro.

```
mastro myapp search ...
  → BrowserTransport (SDK)
  → POST  http://127.0.0.1:<port>/proxy/request        (CLI submits a request)
  → extension long-polls GET /proxy/poll               (picks up the request)
  → runs fetch() in the user's logged-in app tab       (page context)
  → POST /proxy/response/<id>                           (returns status+body)
  → BrowserTransport resolves                           (CLI gets the JSON)
```

No curl. Because the fetch runs in the user's real browser tab, it behaves
exactly like the app's own requests.

## Where the fetch runs (critical)

- A **service-worker** `fetch()` in the extension goes through the network stack
  cold, without the page's context → treated as a non-browser client. ❌
- A `fetch()` initiated from the **page context of a loaded, logged-in app
  tab** carries that page's context and same-origin cookies, like the app's own
  calls. ✅

So the proxy executes the request via a content script injected into an
authenticated tab on the target origin (reusing the page-bridge injection
mechanism), **not** from the service worker.

## Protocol (long-poll, no WebSocket)

The receiver runs in a longer-lived "proxy mode" for the duration of a CLI
command (not just the login capture).

| Method | Path | Who | Purpose |
| ------ | ---- | --- | ------- |
| `POST` | `/proxy/request` | CLI | Submit `{ id, origin, method, url, headers, body }`; long-polls for the matching response. |
| `GET`  | `/proxy/poll` | extension | Long-poll; returns the next pending request (or 204 after a timeout). |
| `POST` | `/proxy/response/<id>` | extension | Return `{ status, headers, bodyText }`. |

Each request has a random `id`; the CLI's POST resolves when the matching
response lands. Everything is loopback-only and in-memory.

## Tab lifecycle

- The extension finds an existing tab on the request's `origin`. If none, it
  opens one (background) and waits for it to load.
- The content script on that tab runs the `fetch()` and posts the result back.
- Tabs the proxy opened are closed when idle; tabs the user already had are left
  alone.

## Jobs

Each queued job carries a `kind`:

- **`fetch`** — `{ origin, method, url, headers, body }`: run the request in
  the page and return `{ status, headers, bodyText }` (everything above).
- **`handoff`** — `{ origin, url, local_storage }`: write the entries to the
  tab's `localStorage`, navigate it to `url`, and focus it. Used by a
  workflow's `handoff` to put a staged flow (a cart) in front of the user.

## Running from the app's tab (`browser_tab_origin`)

By default a fetch runs in a tab on the request URL's own origin. When the API
is a separate host (`api.example.com`) whose CORS admits the app's origin
with credentials, set `x-mastro-replay.browser_tab_origin` to the app's origin:
the fetch then runs from the user's normal app tab and shares its cookie
session, instead of opening a blank tab on the bare API host.

## Selection

A provider opts in via `x-mastro-replay.via_browser: true`. The SDK then uses
`BrowserTransport` instead of curl/fetch. One operation can
opt back out with `x-mastro-transport: direct` (e.g. a public search host).
```
