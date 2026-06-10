---
name: mastro
description: Core conventions for the mastro CLI — unofficial connectors that let agents drive web apps (Depop, Amazon, …) through reverse-engineered APIs replayed with the user's own browser session. Read this before using any mastro provider command, or when the user mentions mastro, asks to log in to a connector, or a mastro command fails with an auth error.
---

# mastro — unofficial connectors for web apps

`mastro` replays a captured browser session against a web app's unofficial
API, so you can search/read/act on sites that have no public API. Each site is
a **provider** (`depop`, `amazon`, …) and each provider exposes subcommands
generated from its spec.

If `mastro` is not on PATH, invoke every command as `npx -y mastro-connect`
instead (e.g. `npx -y mastro-connect depop search "…" --json`).

## The session model

- Credentials are captured **once** from the user's own browser via the
  mastro extension: `mastro login <provider>`. This is interactive — the user
  must be logged in to the site. Never type credentials yourself.
- Check state before calling a provider:

  ```bash
  mastro status --json    # { "<provider>": { "state": "active" | ... } }
  ```

  If the provider is missing or not `active`, ask the user to run
  `mastro login <provider>`, then retry.
- `mastro logout <provider>` forgets a stored session.

## Conventions

- `mastro providers --json` lists installed connectors.
- `mastro <provider> --help` lists that provider's commands;
  `mastro <provider> <command> --help` lists flags. Both are generated from
  the provider's spec — trust `--help` over any memorized flag list.
- **Always pass `--json`** when you consume output; the default output is for
  humans.
- Exit code 2 means you misused a flag (read the message); 1 is a runtime
  failure. An auth error usually means the session expired — re-login.
- Providers carry rate limits. If a command reports throttling, slow down;
  don't loop-retry.
- Commands that change real-world state (orders, listings) support
  `--dry-run`. Dry-run first and confirm with the user before anything that
  spends money or posts publicly.

## Per-provider skills

Detailed playbooks ship with each provider. Install them next to this skill:

```bash
mastro skills add <provider>            # all of a provider's skills
mastro skills add <provider>/<skill>    # one skill
```
