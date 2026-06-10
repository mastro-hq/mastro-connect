<div align="center">

# mastro&nbsp;·&nbsp;connect

**Unofficial connectors for web apps — so agents (and you) can drive them from the terminal.**

```bash
mastro login depop
mastro depop search "carhartt jacket" --conditions used_good --sizes M --json
```

[Concept](#the-idea) · [Quickstart](#quickstart) · [How it works](#how-it-works) · [Agent skills](#agent-skills) · [Add a connector](#adding-a-connector) · [Docs](#documentation) · [Ethics](#ethics--scope)

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
![Bun](https://img.shields.io/badge/runtime-Bun-black)
![OpenAPI 3.1](https://img.shields.io/badge/spec-OpenAPI%203.1-black)

</div>

---

## The idea

Most useful web apps don't have an official API — or the one they have is slower,
more locked-down, or missing the thing you need. But you're already logged into
the app in your browser. **mastro turns that session into a real API.**

It does three things:

1. **Captures** your existing browser session through a small Chrome extension (no
   passwords typed, no scraping — it reads the auth your browser already holds).
2. **Stores** only the minimal credential needed to replay requests.
3. **Replays** that session against the app's own (reverse-engineered) API, and
   exposes each endpoint as a clean CLI command — JSON in, JSON out, agent-ready.

The headline feature: **adding a connector is data, not code.** You describe an
app's API as a standard **OpenAPI 3.1 document** (plus a few `x-mastro-*`
extensions for the things OpenAPI can't express), drop it in `providers/`, and
the same rails handle login, command dispatch, filters, pagination, and even
multi-step flows. No per-connector code.

```text
mastro login depop                       # capture your Depop session via the browser
mastro depop search "polo sweater" --sizes M --conditions used_good --json
mastro depop list  --photo a.jpg --brand nike --type tshirts ... --dry-run
mastro depop me
```

> **Why "mastro"?** It's the conductor — it doesn't play every instrument, it
> coordinates the browser, the session, and the API so the whole thing performs.

---

## Quickstart

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.1 (the runtime; the launcher tells you if it's missing)
- Google Chrome (for the capture extension)

### 1. Install

```bash
npm install -g mastro-connect    # puts `mastro` on your PATH
mastro --help
```

Or zero-install: prefix every command with `npx -y mastro-connect` instead of
`mastro`. Working on mastro itself? Clone the repo, `bun install`, and use
`bun run mastro …`.

### 2. Load the capture extension (one time)

```bash
mastro extension install
```

This copies the bundled extension to `~/.mastro/extension` and walks you
through `chrome://extensions` → **Developer mode** → **Load unpacked**. Pin
**mastro · connect** — click its icon any time to see capture status. (From a
repo checkout you can load the [`extension/`](extension) folder directly.)

### 3. Log in to a connector

Make sure you're signed in to the target app in Chrome, then:

```bash
mastro login depop
```

A localhost tab opens, then the app's tab. The extension reads your session and
hands it back; mastro validates and stores it under `~/.mastro/`. Confirm with:

```bash
mastro status
```

### 4. Use it

```bash
mastro depop --help                          # list the connector's commands
mastro depop search "vintage levis" --json   # call one
```

That's it. Use `--json` for machine-readable output (ideal for agents/scripts).

---

## How it works

```text
        ┌──────────┐   login    ┌──────────────┐   manifest   ┌────────────────┐
        │  mastro  │──────────▶ │  Auth Broker │────────────▶ │  Chrome ext    │
        │   CLI    │            │  + Receiver  │ ◀──capture── │  (MV3, generic)│
        └────┬─────┘            └──────┬───────┘   bundle     └───────┬────────┘
             │                         │                              │ observes
             │ <provider> <command>    ▼                              ▼
             │                  ┌──────────────┐               ┌────────────────┐
             └────────────────▶ │  Mastro SDK  │               │  target SaaS   │
                                │  • auth load │               │  (depop.com)   │
                                │  • replay    │◀──────────────┤                │
                                │  • workflows │  browser-proxy └────────────────┘
                                └──────┬───────┘    (past Cloudflare)
                                       │ reads
                                ┌──────▼────────┐
                                │ providers/<p> │  openapi.yaml + auth.manifest.json
                                └───────────────┘
```

The design line:

> **Provider manifests define _what_ to capture. The broker defines _how_ to
> capture. Applications consume _validated_ credentials.**

### The four moving parts

#### 1. The capture extension — [`extension/`](extension)

A **generic** MV3 Chrome extension. It has no per-connector code: it interprets
whatever `auth.manifest.json` the CLI hands it. During `mastro login` it observes
the target tab (cookies via `chrome.cookies`, headers via `webRequest`, page
fetch/XHR via an injected page-bridge), decides when capture is complete from the
manifest's declarative rules, serializes a minimal credential bundle, and posts it
back to a loopback receiver. Click its toolbar icon to watch live status.

It only ever observes tabs tied to an active capture session; ordinary browsing is
never touched, and the session lives in memory and expires fast.

#### 2. The core — [`@mastro/core`](packages/core)

The engine. The **broker** runs a capture session: it stands up a localhost
**receiver**, opens the browser, waits for the bundle, validates it, and writes a
minimal credential through the **credential store** (a file store at `~/.mastro/`,
mode `0600`; the interface is pluggable for keychain/secret-manager backends). It
also loads and validates each provider's **OpenAPI spec**.

#### 3. The SDK — [`@mastro/sdk`](packages/sdk)

The replay layer. Given a logged-in connector, it builds a request from an OpenAPI
operation + your CLI flags (query/path/body params, array `style`/`explode`,
enums, defaults), applies the `x-mastro-auth` binding (headers, cookies,
per-request `${uuid}` values), resolves dynamic filter values against the app's
taxonomy endpoints (cached), runs the request through the right **transport**, and
maps the response. It also runs multi-step **workflows**.

#### 4. The CLI — [`@mastro/cli`](packages/cli)

The `mastro` binary. Built-in verbs (`login`, `logout`, `status`, `providers`)
plus **per-provider commands generated from the OpenAPI operations**. Flags come
from the operation's parameters; their allowed values come from `schema.enum`;
help is auto-generated. The CLI is a thin, faithful projection of the spec.

---

## Why OpenAPI (and the `x-mastro-*` extensions)

A connector's API is described as a **valid OpenAPI 3.1 document**. Standard
tooling validates and code-gens it — `providers/depop/openapi.yaml` passes
`redocly lint` clean.

OpenAPI natively covers the surface every API shares: paths, methods,
multiple-choice fields (`enum`), repeatable params (`array` + `style`/`explode`),
and an auth inventory. The three things it genuinely **can't** express — and they're
exactly the reverse-engineering parts — live in spec-legal `x-mastro-*` extensions
(conformant validators ignore unknown `x-` keys, so the doc stays valid OpenAPI):

| Extension | Solves |
| --- | --- |
| `x-mastro-auth` | How a captured credential becomes a live request: header/cookie templates and **per-request generated values** (`${uuid}`, `${now}`). |
| `x-mastro-resolve` | **Dynamic enums** whose valid values come from another endpoint's response, or bundled reference data (e.g. Depop's size/brand taxonomies). |
| `x-mastro-replay` | Transport tuning OpenAPI doesn't model: browser impersonation / browser-proxy, retry & re-capture status codes, rate limits. |
| `x-mastro-workflow` | Multi-step stateful flows (upload → poll → create) that aren't a single request. |
| `x-mastro-command` / `-result` / `-hidden` | CLI projection: the subcommand name, the response path to print, hiding metadata-only endpoints. |

See [`docs/AUTHORING.md`](docs/AUTHORING.md) for the full reference.

---

## Notable capabilities

These are general features of the framework, not Depop-specific hacks — every
connector gets them for free.

### Getting past bot protection — the browser proxy

Some sites (Depop) sit behind a Cloudflare **managed challenge** (the "Just a
moment" JS interstitial). TLS impersonation alone can't solve it. So when a
provider sets `x-mastro-replay.via_browser`, mastro runs the request **inside your
already-logged-in browser tab** — which Cloudflare already trusts — and relays the
JSON back. No headless browser, no challenge-solving service; it _is_ a real
browser. → [`docs/BROWSER-PROXY.md`](docs/BROWSER-PROXY.md)

### Human-friendly filters — taxonomy resolution

A flag can accept either a wire id _or_ a human label, resolved against the app's
own filter-metadata endpoints (fetched once, cached under `~/.mastro/cache/`) or a
bundled JSON file. So `--sizes M` becomes the right internal id automatically, and
`mastro depop search --help` shows real, current choices.

### Multi-step flows — workflows

A command can be a declarative sequence of steps with data flowing between them
(`foreach` with index pairing, `poll`-until, binary uploads, per-step transport,
pure-transform steps, and typed/derived body fields). Depop's "list an item" is
upload-each-photo → poll-until-processed → create-listing, expressed entirely in
the OpenAPI doc. `--dry-run` prints every planned request body without sending
anything. → [`docs/WORKFLOWS.md`](docs/WORKFLOWS.md)

---

## Agent skills

Every connector ships **agent skills** — `SKILL.md` playbooks that teach an AI
agent when and how to drive it (preconditions, `--json` shapes, rate limits,
safety rules like "dry-run before spending money"). They live inside the
provider definition (`providers/<id>/skills/<skill>/SKILL.md`), so a fix to a
drifting API and the playbook that documents it travel in the same PR.

```bash
mastro skills list                   # what's available
mastro skills add depop              # install into ./.claude/skills (project)
mastro skills add amazon/search --global    # ~/.claude/skills (everywhere)
mastro skills add depop --dir .agents/skills
mastro skills update                 # refresh everything installed here
```

Every install also drops the root `mastro` skill — the session-model
conventions (login, `status --json`, exit codes) every provider skill builds
on. Installed skills carry a `.mastro.json` provenance stamp so `update` knows
what it owns.

Because skills are standard-format `SKILL.md` directories in a public GitHub
repo, generic skill installers (e.g. `npx skills add`) can fetch them too —
`mastro skills add` is just the convenience path that already knows your
installed providers.

When a site changes faster than the npm package, pull a connector's latest
definition (spec + skills) straight from GitHub:

```bash
mastro providers add depop     # → ~/.mastro/providers/depop (pinned to a commit)
mastro providers update        # re-fetch everything you've added
```

User-fetched providers shadow the bundled ones, so a fix lands without waiting
for a release.

---

## Adding a connector

A connector is a folder under `providers/` with two files (plus docs). **No code.**

```text
providers/<name>/
  auth.manifest.json   # what the extension captures in the browser
  openapi.yaml         # the API surface — OpenAPI 3.1 + x-mastro-* extensions
  README.md            # how it works, how it was reverse-engineered, drift notes
  reference/           # optional bundled lookup data (taxonomies)
  skills/<skill>/      # agent skills: SKILL.md (frontmatter: name, description)
```

The short version:

1. Log into the app, open DevTools → Network, do the action you want to automate.
2. Note the **auth artifact** (cookie? bearer token?), the **base origin**, the
   **endpoint** (path, params, headers), and whether it's behind bot protection.
3. Write `auth.manifest.json` (capture rules) and `openapi.yaml` (the API, with
   `x-mastro-*` for auth/replay/dynamic filters).
4. `mastro providers` should list it; `mastro <name> --help` should show its
   commands. Validate the spec with any OpenAPI validator.

Full walkthrough: **[`docs/AUTHORING.md`](docs/AUTHORING.md)**. Worked example:
**[`providers/depop`](providers/depop)**.

Point mastro at out-of-tree providers with `MASTRO_PROVIDERS=/path/to/dir`.

---

## Project layout

```text
mastro-connect/
├── packages/
│   ├── core/        @mastro/core — schemas, OpenAPI loader, registry,
│   │                credential store, broker, receiver, proxy server
│   ├── sdk/         @mastro/sdk — connector, transports, taxonomy resolver,
│   │                workflow runner, templating
│   └── cli/         @mastro/cli — the `mastro` binary
├── extension/       generic MV3 capture + browser-proxy runtime (plain JS, type-checked)
├── providers/
│   ├── depop/       first connector (search, me, list) + skills
│   └── amazon/      search, detail, Buy Now order + skills
├── skills/
│   └── mastro/      the root agent skill (session model, conventions)
├── bin/             node launcher shim for npx/global installs
└── docs/            AUTHORING · BROWSER-PROXY · WORKFLOWS
```

Bun + TypeScript throughout (strict; the extension JS is `checkJs`-verified).
From a checkout everything runs on Bun directly — the only build step is
`bun run build`, which bundles the CLI into `dist/` for the npm package.

```bash
bun test            # run the test suite
bun run typecheck   # type-check everything (TS + extension)
bun run mastro …    # run the CLI from source
```

---

## Documentation

| Doc | What it covers |
| --- | --- |
| [`docs/AUTHORING.md`](docs/AUTHORING.md) | Build a connector: manifest + OpenAPI + `x-mastro-*` reference. |
| [`docs/BROWSER-PROXY.md`](docs/BROWSER-PROXY.md) | How requests run inside a real browser tab to beat managed challenges. |
| [`docs/WORKFLOWS.md`](docs/WORKFLOWS.md) | Multi-step flows: steps, `foreach`, `poll`, dry-run. |
| [`extension/README.md`](extension/README.md) | The capture extension internals. |
| [`providers/depop/README.md`](providers/depop/README.md) | The Depop connector, end to end. |

---

## Ethics & scope

mastro is built for legitimate personal automation — driving apps _you_ are
logged into, on _your_ behalf.

- It operates **only** within a browser session the current user already controls.
  It does not bypass authorization or consent, and it never types or stores
  passwords.
- It persists the **minimum** credential needed to replay, stored locally with
  tight permissions; tokens and cookies are redacted in all logs.
- Prefer official APIs where they exist and fit. Unofficial APIs are operational
  contracts with drift detection — not stable guarantees, and not a license to
  abuse a service.
- Respect each service's Terms of Service and rate limits. You are responsible for
  how you use it.

---

## Contributing

Contributions welcome — especially new connectors. A good connector PR includes a
validated `openapi.yaml`, an `auth.manifest.json`, a `README.md` documenting the
reverse-engineering and drift symptoms, and **no committed credentials or
unredacted HARs** (the `.gitignore` guards the obvious cases — double-check).

Run `bun test` and `bun run typecheck` before opening a PR.

## License

[MIT](LICENSE) © Giulio Colleluori
