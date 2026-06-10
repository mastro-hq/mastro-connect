# Authoring a connector

A connector is a folder under `providers/<id>/` with **two files** (plus docs):

```
providers/<id>/
  auth.manifest.json            # what the extension captures in the browser
  openapi.yaml | openapi.json   # the API surface (OpenAPI 3.1 + x-mastro-*)
  README.md                     # how it works, how it was reverse-engineered
  skills/                       # optional agent-facing playbooks
```

Validate as you go:

```bash
bun run mastro providers           # lists your new id
bun run mastro <id> --help         # lists commands (from OpenAPI operations)
bun run mastro <id> <cmd> --help   # lists flags (from operation parameters)
```

---

## Why OpenAPI (and where it stops)

The API half of a connector is a **valid OpenAPI 3.1 document**. OpenAPI already
nails the parts every API has: paths, methods, query/path/body params,
**multiple-choice fields** (`schema.enum`), **repeatable params**
(`type: array` + `style`/`explode`), and an auth *inventory*. Standard tooling
validates and code-gens it.

Three things OpenAPI genuinely **cannot** express — and they're exactly the
reverse-engineering parts — live in spec-legal `x-mastro-*` extensions
(conformant validators ignore unknown `x-` keys, so the doc stays valid
OpenAPI):

| Extension | Problem it solves |
| --- | --- |
| `x-mastro-auth` (root) | How a captured credential becomes a live request: header/cookie templates, and **per-request generated values** (`${uuid}`, `${now}`). OpenAPI `securityScheme` only names the credential, never how to mint it. |
| `x-mastro-resolve` (on a parameter) | **Dynamic enums**: valid values come from *another operation's response* (e.g. Depop's sizes/brands taxonomies), not a static list. JSON Schema `enum` is static literals only. |
| `x-mastro-replay` (root) | Transport tuning OpenAPI doesn't model: browser impersonation (Cloudflare JA3), retry/recapture status codes, rate limit, following HTML meta-refresh bot walls (Akamai bm-verify → `follow_html_refresh`). |
| `x-mastro-extract` (on an operation) | **HTML-only responses**: some sites have no JSON API at all (Amazon search/detail) — the data exists only server-rendered. An `items` CSS selector plus per-field selectors/attributes turn the page into an array of flat objects; omit `items` for **single-object mode** (a detail page → one object). Field selectors must not match nested elements within one item. |
| `x-mastro-form` (on a workflow step's `request`) | **Form-gated state changes**: a POST guarded by a server-rendered `<form>` with a one-time CSRF token + many hidden fields (Amazon Buy Now → place-order). Point at the form in a prior step's HTML; it's serialized exactly as a browser would submit it (FormData semantics, first matching form only), with `set`/`unset` for the fields submission adds. |
| `x-mastro-command` / `x-mastro-result` / `x-mastro-hidden` (on an operation) | CLI projection: the subcommand name, the response path to pretty-print, and hiding metadata-only endpoints. |

> Don't invent human-friendly aliases. Flags and their allowed values are
> **whatever the API supports**, read straight from the spec. `x-mastro-resolve`
> exists only because the API itself serves the value list from another endpoint.

---

## 1. Reverse-engineer the session

Open the app logged-in, open DevTools → Network, do the action you want
(search, fetch). Identify the **minimum** to replay it:

- **Auth artifact** — cookie? bearer header? token in a JSON response? Note
  `HttpOnly` cookies (page JS can't read them, but the extension's
  `chrome.cookies` can).
- **Base origin** + exact path, query params, and which headers matter.
- **Anti-bot** — Cloudflare/Akamai? (a `403` HTML page to a non-browser client
  is the tell) → set `x-mastro-replay.impersonate_browser`.
- **Filter taxonomies** — does the app fetch its filter options from dedicated
  endpoints (sizes, brands, categories)? Those become `x-mastro-resolve`
  sources.

Save a **redacted** HAR for your notes. Never commit unredacted captures.

---

## 2. Write `auth.manifest.json`

Declares what the extension captures and when it's done. (Unchanged by the
OpenAPI switch — this is the browser half.) See `providers/depop` and the
manifest schema in `packages/core/src/schemas/`.

The serialized fields become the credential the OpenAPI `x-mastro-auth` consumes
via `${auth.<field>}`.

---

## 3. Write `openapi.yaml`

Standard OpenAPI for the surface, `x-mastro-*` for the rest:

```yaml
servers: [{ url: https://www.example.com }]

x-mastro-replay: { impersonate_browser: true, recapture_on: [401, 419] }

x-mastro-auth:
  required_fields: [access_token]
  headers:
    authorization: "Bearer ${auth.access_token}"
    x-request-id: "${uuid}"            # fresh per request

paths:
  /api/search/:
    get:
      operationId: search
      x-mastro-result: results          # pretty-print response.results
      parameters:
        - name: q
          in: query
          required: true
          schema: { type: string }
        - name: condition                # closed vocabulary → enum
          in: query
          explode: true
          schema: { type: array, items: { type: string, enum: [new, used] } }
        - name: brand                    # dynamic taxonomy → resolve
          in: query
          explode: true
          schema: { type: array, items: { type: string } }
          x-mastro-resolve:
            from: brandsEndpoint          # operationId that returns the list
            value_path: brands[].id
            label_path: brands[].name
  /api/brands/:
    get:
      operationId: brandsEndpoint
      x-mastro-hidden: true              # metadata only — not a CLI command
```

- An operation with a `command` (via `x-mastro-command` or `operationId`)
  becomes `mastro <id> <command>`. Its `parameters` become flags; the first
  declared param also binds to the first positional.
- `enum` (on the param or its array `items`) is validated and shown in `--help`.
- `x-mastro-resolve` params accept **either** the wire id **or** a label; the
  SDK fetches the taxonomy once, caches it (`~/.mastro/cache/<id>/`, default
  24h), and translates.
- Array params serialize per OpenAPI `style`/`explode` (query default is
  `form`/`explode: true` → `?k=a&k=b`).

---

## 4. Document & add a skill

`README.md`: what it does, the auth mechanism, an endpoints table, and **drift
symptoms + recapture steps**. Note any external binary needed (e.g.
`curl-impersonate`).

`skills/<command>.md`: agent-facing playbook — when to use it, preconditions
(logged in?), the exact command with `--json`, how to read the result, what to
do on an auth error.

---

## Checklist

- [ ] Prefer an official API if one exists and fits.
- [ ] Capture the **minimum** artifacts — nothing you don't replay.
- [ ] `x-mastro-auth.required_fields` covers everything the operations need.
- [ ] Secrets listed in `auth.manifest` `redact_fields` and `x-mastro-auth.redact`.
- [ ] Closed value sets are `enum`; API-served value sets are `x-mastro-resolve`.
- [ ] `x-mastro-replay.recapture_on` distinguishes auth-expiry from other errors.
- [ ] The document still validates as OpenAPI 3.1 (run it through any validator).
- [ ] No unredacted HARs or credentials committed.
