# Browser-proxy transport

## Why

Some sites (Depop) sit behind a Cloudflare **managed challenge** — an
interstitial that requires executing JavaScript to obtain clearance. TLS
impersonation (`curl-impersonate`) replays a Chrome handshake but **cannot solve
the JS challenge**, so it gets a `403 "Just a moment"` even with the captured
cookie jar.

The user already has a browser tab that is *past* the challenge (they're logged
in). So instead of replaying the request from outside, we **run it inside that
tab's page context**, where Cloudflare already trusts the session, and relay the
JSON back to the CLI.

```
mastro depop search ...
  → BrowserTransport (SDK)
  → POST  http://127.0.0.1:<port>/proxy/request        (CLI submits a request)
  → extension long-polls GET /proxy/poll               (picks up the request)
  → runs fetch() in an authenticated depop.com tab     (page context, past CF)
  → POST /proxy/response/<id>                           (returns status+body)
  → BrowserTransport resolves                           (CLI gets the JSON)
```

No curl. Because the fetch runs in a real, challenge-cleared browser tab, it
works for any JS-challenge site, not just Depop.

## Where the fetch runs (critical)

- A **service-worker** `fetch()` in the extension goes through the network stack
  cold → Cloudflare-challenged. ❌
- A `fetch()` initiated from the **page context of a loaded, logged-in
  depop.com tab** carries that page's solved-challenge context and same-origin
  cookies → passes. ✅

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
  opens one (background) and waits for it to load (and clear Cloudflare).
- The content script on that tab runs the `fetch()` and posts the result back.
- Tabs the proxy opened are closed when idle; tabs the user already had are left
  alone.

## Selection

A provider opts in via `x-mastro-replay.via_browser: true`. The SDK then uses
`BrowserTransport` instead of curl/fetch. (Depop sets this.)
```
