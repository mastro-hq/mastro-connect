<div align="center">

# mastro&nbsp;·&nbsp;connect

**Build agent connectors for the web apps you use. Describe the app's API as data, and drive it from the terminal.**

```bash
mastro hackernews top --limit 5          # the bundled example connector
mastro login myapp                       # capture your session for a connector you wrote
mastro myapp search "red jacket" --json
```

[Concept](#the-idea) · [Quickstart](#quickstart) · [How it works](#how-it-works) · [Build a connector](#building-a-connector) · [Agent skills](#agent-skills) · [Docs](#documentation) · [Ethics](#ethics--scope)

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
![Bun](https://img.shields.io/badge/runtime-Bun-black)
![OpenAPI 3.1](https://img.shields.io/badge/spec-OpenAPI%203.1-black)

</div>

---

## The idea

Agents increasingly act on the web for their users, mostly by driving a
browser click by click: slow, brittle, and expensive. But the web app you're
logged into already talks to its own backend through a perfectly good API.
**mastro lets you describe that API once and turn your existing session into
clean, agent-ready commands.**

It does three things:

1. **Captures** your existing browser session through a small Chrome extension (no
   passwords typed, no scraping — it reads the auth your browser already holds).
2. **Stores** only the minimal credential needed to replay requests, locally.
3. **Replays** that session against the app's own API, exposing each endpoint as
   a CLI command — JSON in, JSON out — from your machine, optionally through your
   own browser tab.

The headline feature: **a connector is data, not code.** You describe an app's
API as a standard **OpenAPI 3.1 document** (plus a few `x-mastro-*` extensions
for the things OpenAPI can't express) and a capture manifest, and the same rails
handle login, command dispatch, filters, pagination, and multi-step flows. And
because it's data, **an agent can write one**: the bundled `mastro-author` skill
walks it from capture to a validated connector.

> **Why "mastro"?** In Italian a _mastro_ is the master of a craft — the
> _mastro falegname_ (master carpenter), the expert who's earned the title.
> That's the point: give people the right skills and infrastructure and they
> become the master of any app they use — not waiting on an official API, but
> driving the tools themselves, expertly.

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

### 2. Try the example connector

mastro ships one connector, [`hackernews`](providers/hackernews), over Hacker
News's official public API — no login needed:

```bash
mastro hackernews --help
mastro hackernews top --limit 5 --json
```

### 3. Build (or add) a connector

Let an agent build one for an app you use:

```bash
mastro skills add mastro-author --global   # then ask your agent: "make a mastro connector for <app>"
```

…or write it by hand ([`docs/AUTHORING.md`](docs/AUTHORING.md)), or fetch one
from a connector repo you have access to:

```bash
mastro providers add <id> --repo <owner>/<repo>
```

### 4. Log in and use it

Load the capture extension once:

```bash
mastro extension install
```

This copies the bundled extension to `~/.mastro/extension` and walks you
through `chrome://extensions` → **Developer mode** → **Load unpacked**. Pin
**mastro · connect** — click its icon any time to see capture status. (From a
repo checkout you can load the [`extension/`](extension) folder directly.)

Then, signed in to the app in Chrome:

```bash
mastro login myapp          # a localhost tab opens, then the app's tab
mastro status               # confirm the session is stored and verified
mastro myapp --help         # the connector's commands
mastro myapp search "vintage levis" --json
```

Use `--json` for machine-readable output (ideal for agents and scripts).

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
             └────────────────▶ │  Mastro SDK  │               │   the web app  │
                                │  • auth load │               │  (your session)│
                                │  • replay    │◀──────────────┤                │
                                │  • workflows │  browser-proxy └────────────────┘
                                └──────┬───────┘  (your own tab)
                                       │ reads
                                ┌──────▼────────┐
                                │ providers/<p> │  openapi.yaml + auth.manifest.json
                                └───────────────┘
```

Everything runs on your machine: credentials never leave it, and requests go
from your computer (or through your own browser tab) to the app.

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

The `mastro` binary. Built-in verbs (`login`, `logout`, `status`, `providers`,
`skills`, `validate`) plus **per-provider commands generated from the OpenAPI
operations**. Flags come from the operation's parameters; their allowed values
come from `schema.enum`; help is auto-generated. The CLI is a thin, faithful
projection of the spec.

---

## Why OpenAPI (and the `x-mastro-*` extensions)

A connector's API is described as a **valid OpenAPI 3.1 document**, so standard
tooling validates and code-gens it.

OpenAPI natively covers the surface every API shares: paths, methods,
multiple-choice fields (`enum`), repeatable params (`array` + `style`/`explode`),
and an auth inventory. The things it genuinely **can't** express live in
spec-legal `x-mastro-*` extensions (conformant validators ignore unknown `x-`
keys, so the doc stays valid OpenAPI):

| Extension | Solves |
| --- | --- |
| `x-mastro-auth` | How a captured credential becomes a live request: header/cookie templates and **per-request generated values** (`${uuid}`, `${now}`). |
| `x-mastro-resolve` | **Dynamic enums** whose valid values come from another endpoint's response, or bundled reference data (e.g. an app's size/brand taxonomies). |
| `x-mastro-replay` | Transport tuning OpenAPI doesn't model: browser-proxy, retry & re-capture status codes, rate limits. |
| `x-mastro-extract` | Structured objects out of server-rendered HTML or React Server Components streams. |
| `x-mastro-workflow` | Multi-step stateful flows (upload → poll → create) that aren't a single request. |
| `x-mastro-command` / `-result` / `-hidden` | CLI projection: the subcommand name, the response path to print, hiding metadata-only endpoints. |

See [`docs/AUTHORING.md`](docs/AUTHORING.md) for the full reference.

---

## Notable capabilities

General features of the framework — every connector gets them for free.

### Running in your own browser — the browser proxy

Some apps only answer requests that come from a real browser session. When a
provider sets `x-mastro-replay.via_browser`, mastro runs the request **inside
your already-logged-in browser tab** and relays the response back — the same
way the app's own frontend calls its API. No headless browser, no
challenge-solving. → [`docs/BROWSER-PROXY.md`](docs/BROWSER-PROXY.md)

### Human-friendly filters — taxonomy resolution

A flag can accept either a wire id _or_ a human label, resolved against the app's
own filter-metadata endpoints (fetched once, cached under `~/.mastro/cache/`) or a
bundled JSON file. So `--sizes M` becomes the right internal id automatically, and
`mastro <app> search --help` shows real, current choices.

### Multi-step flows — workflows

A command can be a declarative sequence of steps with data flowing between them
(`foreach` with index pairing, `poll`-until, binary uploads, per-step transport,
pure-transform steps, and typed/derived body fields) — e.g. upload each photo →
poll until processed → create the listing, expressed entirely in the OpenAPI
doc. `--dry-run` prints every planned request body without sending anything. A
workflow can also stage something and **hand it back to the browser** for you
to finish — fill a cart, then open it in your tab to pay.
→ [`docs/WORKFLOWS.md`](docs/WORKFLOWS.md)

---

## Building a connector

A connector is a folder with two files (plus docs). **No code.**

```text
providers/<name>/
  auth.manifest.json   # what the extension captures in the browser
  openapi.yaml         # the API surface — OpenAPI 3.1 + x-mastro-* extensions
  README.md            # how it works, endpoints, drift symptoms
  reference/           # optional bundled lookup data (taxonomies)
  skills/<skill>/      # agent skills: SKILL.md (frontmatter: name, description)
```

**With an agent:** `mastro skills add mastro-author` installs a skill that
walks an agent through capturing the app's traffic, finding the minimal auth,
writing the manifest and spec, validating, and testing — read-only first, with
write operations behind `--dry-run` and your confirmation.

**By hand:**

1. Log into the app, open DevTools → Network, do the action you want to automate.
2. Note the **auth artifact** (cookie? bearer token?), the **base origin**, the
   **endpoint** (path, params, headers), and whether it needs a real browser.
3. Write `auth.manifest.json` (capture rules) and `openapi.yaml` (the API, with
   `x-mastro-*` for auth/replay/dynamic filters).
4. Check it:

   ```bash
   mastro validate providers/<name>   # schema, references, templates, no committed secrets
   mastro <name> --help               # the generated commands
   ```

Full walkthrough: **[`docs/AUTHORING.md`](docs/AUTHORING.md)**. Minimal worked
example: **[`providers/hackernews`](providers/hackernews)**.

### Where connectors live

mastro searches, in order: `$MASTRO_PROVIDERS` (colon-separated directories),
`~/.mastro/providers`, then the bundled example. Keep your connectors in their
own git repo (`providers/<id>/` at its root) and either point
`MASTRO_PROVIDERS` at a checkout or fetch from it:

```bash
mastro providers add myapp --repo you/connectors   # → ~/.mastro/providers/myapp, pinned to a commit
mastro providers update                            # re-fetch everything you've added
```

Private repos work: mastro authenticates with `GITHUB_TOKEN` / `GH_TOKEN`, or
your `gh` login. Run `mastro validate` in the connector repo's CI.

---

## Agent skills

Connectors ship **agent skills** — `SKILL.md` playbooks that teach an AI agent
when and how to drive them (preconditions, `--json` shapes, rate limits, safety
rules like "dry-run before spending money"). They live inside the provider
definition (`providers/<id>/skills/<skill>/SKILL.md`), so a fix to a drifting
API and the playbook that documents it travel together.

```bash
mastro skills list                       # what's available
mastro skills add hackernews             # install into ./.claude/skills (project)
mastro skills add myapp/search --global  # ~/.claude/skills (everywhere)
mastro skills add myapp --dir .agents/skills
mastro skills add mastro-author          # the connector-authoring skill
mastro skills update                     # refresh everything installed here
```

Every install also drops the root `mastro` skill — the session-model
conventions (login, `status --json`, exit codes) every provider skill builds
on. Installed skills carry a `.mastro.json` provenance stamp so `update` knows
what it owns.

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
│   └── hackernews/  the example connector (official public API)
├── skills/
│   ├── mastro/        the root agent skill (session model, conventions)
│   └── mastro-author/ the connector-authoring skill
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
| [`docs/BROWSER-PROXY.md`](docs/BROWSER-PROXY.md) | How requests run inside your real browser tab. |
| [`docs/WORKFLOWS.md`](docs/WORKFLOWS.md) | Multi-step flows: steps, `foreach`, `poll`, handoff, dry-run. |
| [`extension/README.md`](extension/README.md) | The capture extension internals. |
| [`skills/mastro-author`](skills/mastro-author/SKILL.md) | The agent playbook for building a connector. |

---

## Ethics & scope

mastro is a framework for personal automation — an agent acting for **you**,
in apps **you** are logged into, the way you would by hand.

- It operates **only** within a browser session the current user already
  controls, on the user's own machine. It does not bypass authorization or
  consent, never types or stores passwords, and never sends credentials
  anywhere but the app itself.
- It persists the **minimum** credential needed to replay, stored locally with
  tight permissions; tokens and cookies are redacted in all logs.
- It is not a scraper: connectors act on the user's own account at a human
  pace (rate limits are part of every spec), not across other people's data.
- It doesn't defeat bot defenses — no CAPTCHA or challenge solving. When an app
  needs a real browser, requests run in the user's own tab.
- Prefer official APIs where they exist and fit. Respect each service's Terms
  of Service. You are responsible for the connectors you build and run.

This repository ships the framework and one example connector over an official
public API. It does not distribute connectors for third-party services.

---

## Contributing

Contributions to the framework are welcome — the core, SDK, CLI, extension,
docs and the authoring skill. Run `bun test` and `bun run typecheck` before
opening a PR.

## License

[MIT](LICENSE) © Giulio Colleluori
