---
name: mastro-amazon-search
description: Search Amazon products from the command line via the mastro CLI. Use when the user wants to find, compare, or price-check products on Amazon ("how much is a decent laptop stand on Amazon?", "find a usb-c hub under $30").
---

# Search Amazon

Agent-facing playbook for searching Amazon products via `mastro`. If `mastro`
is not on PATH, invoke it as `npx -y mastro-connect`.

## When to use

The user wants to find, compare, or price-check products on Amazon ("how much
is a decent laptop stand on Amazon?", "find a usb-c hub under $30").

## Preconditions

- `mastro login amazon` has been run (check `mastro status --json` →
  `amazon.state == "active"`). If absent, ask the user to run
  `mastro login amazon` (it needs the browser).
- Replay runs inside a logged-in amazon.com browser tab via the mastro
  extension — the extension must be enabled (mastro opens the tab if needed).

## Command

```bash
mastro amazon search "<query>" [flags...] --json
```

Run `mastro amazon search --help` for the live flag list (it's generated from
the spec). Flags are Amazon's own `/s` URL params:

- `--s` — sort: `price-asc-rank`, `price-desc-rank`, `review-rank`,
  `date-desc-rank`, `exact-aware-popularity-rank` (default relevance).
- `--low-price` / `--high-price` — price bounds.
- `--i` — department alias (e.g. `electronics`, `fashion`).
- `--page` — 1-based pagination, ~22 items per page.
- `--rh` — raw refinement string copied from a filter URL (advanced).
- Always pass `--json` so you get structured results, not pretty text.
- The first positional is the query — no `--k` flag needed.

## Reading results

The JSON is an array of items extracted from the search page (there is no
JSON API behind it). Per item: `asin`, `title`, `price` (e.g. `"$23.99"`,
current offer), `rating` (`"4.6 out of 5 stars"`), `reviews` (`"(24.9K)"`),
`image`, `url` (relative — prepend `https://www.amazon.com`), `sponsored`
(`"Sponsored"` or `null`). Missing fields are `null`. A stable product link
is `https://www.amazon.com/dp/<asin>`.

## Tips

- Sponsored slots lead the page and skew price reads — for a fair price
  estimate, drop items where `sponsored != null` and use the organic median.
- Values are display strings, not numbers — parse `price` before comparing.
- An empty array on a query that obviously has results means Amazon changed
  its markup — see the drift notes in the provider README.
- Respect the rate limit (12 req/min); batch thoughtfully.
