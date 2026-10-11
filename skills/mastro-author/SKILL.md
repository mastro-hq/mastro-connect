---
name: mastro-author
description: Build a new mastro connector for a web app — capture how the app talks to its own backend, find the minimal session auth, and write the auth.manifest.json + OpenAPI 3.1 spec + skills that turn it into `mastro <app> <command>`. Use when the user wants mastro (or an agent) to work with a site that has no connector yet, says "make a mastro connector for X", "add X to mastro", "reverse-engineer X's API", or asks to add a command to an existing connector or fix one that drifted.
---

# Authoring a mastro connector

A connector is **data, not code**: a folder `providers/<id>/` with

```
auth.manifest.json      what the extension captures from the user's browser
openapi.yaml            the API surface: OpenAPI 3.1 + x-mastro-* extensions
README.md               how it works, endpoints, drift symptoms
skills/<task>/SKILL.md  agent playbooks, installed with `mastro skills add <id>`
```

Every flag, enum and command is generated from the spec — there is no
per-connector code to write. Your job is to observe the app accurately and
describe it. [reference.md](reference.md) (next to this file) has the manifest
schema, the `x-mastro-*` extensions and copy-paste skeletons.

## Hard rules

These keep the user's account safe and the connector defensible. Don't trade
them for convenience.

- **The user's own account, the user's own actions.** A connector does what the
  user could do by hand in their browser, at a human pace. No bulk collection
  of other people's data, no multi-account support, no crawling.
- **Never send state-changing requests while exploring.** During capture and
  minimization replay GETs and read-only POSTs (search) only. Purchases,
  posts, messages, bookings, deletes, follows: observe them in the user's own
  click-through, never replay them to "see what happens".
- **Write operations ship as workflows with `--dry-run`**, and the connector's
  skill must say: dry-run first, show the user, wait for explicit approval.
- **Secrets never touch the repo.** HARs, cookies, tokens and real response
  bodies with personal data stay outside the connector directory (use a temp
  dir). Test fixtures are synthetic. `mastro validate` rejects HAR files and
  live-looking tokens.
- **Don't defeat bot defenses.** No CAPTCHA solving, no challenge solving. If a
  plain client is blocked, run through the user's real tab
  (`x-mastro-replay.via_browser: true`) — that's the user's own browser, which
  already passed the check.
- **Always set `x-mastro-replay.rate_limit`.** Start conservative
  (10–30 requests/minute for authenticated sites).
- **Prefer an official API** if one exists and covers the need — tell the user.

## Workflow

### 0. Scope it with the user

Agree on: the app (and its `<id>`: lowercase, no spaces), the 2–5 **tasks**
the user actually wants (e.g. "search listings", "see my orders"), and which of
those change state. Start with read-only tasks; add writes after reads work.

Pick where the connector lives:

- a connector repo the user has → `providers/<id>/` there, and
  `export MASTRO_PROVIDERS=<repo>/providers` so mastro picks it up;
- otherwise `~/.mastro/providers/<id>/` (searched automatically).

The bundled example is a complete, minimal connector to copy from:
`mastro validate hackernews --json` prints its `dir`.

### 1. Capture the traffic

For each task, the user (logged in, in their own browser) performs it once
while you record the network. Use whatever you have — a browser-automation or
DevTools tool that can list network requests, or ask the user to export a HAR
(DevTools → Network → ⤓) to a path **outside** the repo.

For every request that carries the data the task needs, note: method, full URL,
query, request body, request headers, which cookies were sent, status, and the
response shape. Ignore analytics/telemetry, images, and feature-flag calls.

Classify each one:

| You see | It becomes |
| --- | --- |
| JSON response | a plain operation; `x-mastro-result` picks the useful sub-tree |
| Data only in server-rendered HTML | `x-mastro-extract` (`format: html`, CSS selectors) |
| `text/x-component` / RSC "Flight" rows (`0:…`, `1:I[…]`) | `x-mastro-extract` with `format: flight` |
| Filter values served by another endpoint (brands, sizes) | that endpoint as a hidden op + `x-mastro-resolve` on the param |
| A sequence (upload → poll → create; add-to-cart → checkout) | an `x-mastro-workflow` |
| A step only a human can finish (pay on a hosted form, captcha) | a workflow `handoff` that opens the browser at that point |

### 2. Find the minimal auth

Work out what proves the session: a cookie jar, a bearer token (from a cookie,
`localStorage`, or a login response), a CSRF header mirrored from a cookie,
per-request ids the client generates (`${uuid}`, `${now}`).

Then minimize, **with a read-only request**: replay it from the terminal
(`curl` with the captured headers), confirm 200, and drop headers/cookies one at
a time until it breaks. What's left is what the manifest captures and
`x-mastro-auth` sends. If curl gets a `403` HTML page, "Just a moment…", or a
302 back to the same URL while the browser succeeds, it's a bot wall →
`via_browser: true` (stop probing it from curl).

Pick a cheap read-only "who am I" request for `x-mastro-auth.verify` if the
app has one.

### 3. Write `auth.manifest.json`

Capture exactly the minimal artifacts — narrow `include_names_matching`, named
`storage` keys — set a `completion` rule that's true only once logged in, map
them to `serialization.fields`, and list every secret in
`security.redact_fields`. `provider_id` must equal the directory name.
Skeleton in reference.md.

### 4. Write `openapi.yaml`

- `openapi: 3.1.0`, `servers`, `x-mastro-replay` (rate limit,
  `recapture_on` for auth-expiry codes, `via_browser` if walled),
  `x-mastro-auth` (`required_fields`, header/cookie templates over
  `${auth.<field>}`, `verify`, `redact`).
- One operation per request. `operationId` becomes the command; hide helpers
  with `x-mastro-hidden: true`.
- **Flags are whatever the API takes**, named as the API names them. Don't
  invent aliases. Closed value sets → `enum`; API-served value sets →
  `x-mastro-resolve`.
- Public endpoints (work logged-out) get `security: []`.
- Multi-step tasks → a synthetic path (`/x-mastro/<command>`) with
  `x-mastro-args` + `x-mastro-workflow`. See reference.md.

### 5. Validate and test — loop until clean

```bash
mastro validate <dir>                    # schema, templates, step refs, hygiene
mastro <id> --help                       # commands generated as expected?
mastro <id> <command> --help             # flags/enums right?
mastro login <id>                        # the USER runs this (browser capture)
mastro <id> <read-command> ... --json    # live, read-only
MASTRO_DEBUG=1 mastro <id> <command> ... # raw status + body head when output is wrong
mastro <id> <write-command> ... --dry-run   # writes: plan only
```

Run a write command for real only after the user has seen the dry-run plan and
explicitly approved that exact action.

### 6. Document it

- `README.md`: what it covers, the auth mechanism (what's captured and why),
  an endpoints table, rate limit, **drift symptoms** (what breaks when the app
  changes, and how to recapture).
- `skills/<task>/SKILL.md` per user task, frontmatter
  `name: mastro-<id>-<task>` and a one-line `description` with trigger
  phrases (single-line YAML). Body: preconditions (`mastro status --json`,
  login), the exact command with `--json`, how to read the result, and for
  writes the dry-run → confirm rule. Defer flag lists to `--help`.

Finish with `mastro validate <dir>` clean (warnings explained), and tell the
user what works, what was verified live, and what wasn't.

## When things go wrong

| Symptom | Likely cause → fix |
| --- | --- |
| 401/403 JSON after it worked | session expired → `recapture_on`, user re-runs `mastro login` |
| 403 HTML / "Just a moment" / 302-to-self | bot wall → `via_browser: true` |
| 200 but empty `[]` from an extract | selectors drifted, or a logged-out page → `MASTRO_DEBUG=1`, compare HTML |
| 200 with an error inside the JSON | add `fail_when` to the workflow step |
| Works in the browser tab, CORS error via proxy | API on another host → `browser_tab_origin: <app origin>` |
| Exit code 2 | flag misuse — read the message; check the spec's params |
