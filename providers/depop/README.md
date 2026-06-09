# Depop connector

Drives Depop's web API using your logged-in browser session.

```bash
mastro login depop
mastro depop search "holiday knit jumper men" --sizes M
mastro depop search "carhartt jacket" --conditions used_good --colours green --sortBy priceAscending
mastro depop search "vintage tee" --brandIds nike --priceMax 50 --isDiscounted --json
mastro depop me
```

The connector is described by [`openapi.yaml`](openapi.yaml) (a valid OpenAPI 3.1
document) plus [`auth.manifest.json`](auth.manifest.json) for the browser capture.

## How auth works

Depop's web app stores auth in two cookies on `depop.com`:

| Cookie         | Use                                  |
| -------------- | ------------------------------------ |
| `access_token` | Bearer token for the web API         |
| `user_id`      | Your numeric account id (`x-user-id`)|

`access_token` is **HttpOnly**, so page JavaScript can't read it — the mastro
extension reads it via `chrome.cookies`. `mastro login depop` opens Depop, waits
until both cookies exist, and stores them (token redacted in logs).

Each request also sends client-generated `depop-device-id` / `depop-session-id`
/ `depop-search-id` UUIDs — the spec mints these per request via `${uuid}`.

## How replay works

The web API sits behind a Cloudflare **managed challenge** (the "Just a moment"
JS interstitial). TLS impersonation alone can't solve it — even a perfect Chrome
handshake with the captured cookies gets a `403`. So Depop sets
`x-mastro-replay.via_browser: true`, and mastro runs the request **inside your
logged-in browser tab** (which already cleared the challenge) via the extension.
See [`docs/BROWSER-PROXY.md`](../../docs/BROWSER-PROXY.md).

**Requirement:** the mastro extension must be installed/enabled and you must have
a logged-in **depop.com tab open** (mastro will open one if needed). No
`curl-impersonate` needed.

```
mastro depop search ...
  → mastro proxy server (127.0.0.1:7878)
  → extension runs fetch() in your depop.com tab (past Cloudflare)
  → JSON back to the CLI
```

## Commands

| Command  | Endpoint / flow                                 |
| -------- | ----------------------------------------------- |
| `search` | `GET /presentation/api/v1/search/products/`     |
| `me`     | `GET /api/v1/users/{user_id}/`                  |
| `list`   | multi-step workflow: upload photos → poll → create listing |

### Listing an item

```bash
mastro depop list \
  --photo front.jpg --photo back.jpg \
  --brand polo-ralph-lauren \
  --department menswear --type tshirts --size M \
  --condition used_good --colour navy \
  --price 25 \
  --description "Vintage Polo tee ... #ralphlauren #vintage" \
  --address-id 42475963 --address "San Francisco, United States" \
  --lat 37.779026 --lng -122.419906 \
  [--dry-run]
```

- **Photos must be square JPEGs** (the `depop-list-item` skill handles
  HEIC→JPEG + cropping; mastro uploads them as-is).
- `variant_set` and `gender` are **derived** from `--department`/`--type` via
  bundled reference data (`reference/categories.json`,
  `reference/department_gender.json`) — you don't pass internal ids.
- **`--dry-run` builds and prints every request body without uploading or
  posting** — always dry-run first. See [`docs/WORKFLOWS.md`](../../docs/WORKFLOWS.md).

> Known limitation: mapping a human `--size` (e.g. `M`) to its numeric variant
> id depends on the resolved size-set, a two-step lookup not yet wired — the
> dry-run body currently omits `variants`. The category→size-set and
> department→gender derivations work. (`reference/size_sets.json` is bundled for
> when that lands.)

### Search filters

Every filter from the website's filter bar is a flag, generated from the spec:

| Flag             | Wire param     | Notes |
| ---------------- | -------------- | ----- |
| `--what`         | `what`         | required search text |
| `--categories`   | `categories`   | repeatable; id or label (resolved via `categoryFilters`) |
| `--brandIds`     | `brandIds`     | repeatable; id or brand name (resolved via `brandsById`) |
| `--sizes`        | `sizes`        | repeatable; composite id or label e.g. `M` (resolved via `sizeFilters`) |
| `--colours`      | `colours`      | repeatable; enum (black, grey, white, …) |
| `--conditions`   | `conditions`   | repeatable; enum (brand_new, used_good, …) |
| `--priceMin/Max` | `priceMin/Max` | numeric |
| `--isDiscounted` | `isDiscounted` | boolean; "on sale" |
| `--sortBy`       | `sortBy`       | relevance \| priceAscending \| priceDescending \| newlyListed |
| `--limit`        | `limit`        | results per page (default 24) |
| `--after`        | `after`        | pagination cursor (`page_info.last` of the previous page) |

The `sizes` / `brandIds` / `categories` value lists are **fetched from Depop's
own filter-metadata endpoints** (`sizeFilters`, `brandsById`, `categoryFilters`,
declared `x-mastro-hidden` in the spec) and cached under
`~/.mastro/cache/depop/`, so `--sizes M` resolves to the wire id `54.4`
automatically.

## Status & drift

`status: reverse_engineered` — observed from browser traffic, can change without
notice. If `search` starts returning Cloudflare HTML or a shape without an
`objects` array:

1. `mastro login depop` (most failures are an expired session → `401`/`419`).
2. Capture a fresh HAR from depop.com's Network tab and diff the
   `search/products` request against `openapi.yaml`.

> Reverse-engineered from a real HAR (`~/Downloads/www.depop.com.har`) plus the
> earlier `depop-cli`. The HAR only exercised the `sizes` filter; the other
> param names (`brandIds`, `colours`, `conditions`, `priceMin/Max`,
> `isDiscounted`, `sortBy`) were recovered from the response payloads. The
> `sortBy` enum values should be re-verified on the next capture.

> The write flow (image upload + listing creation) from the original `depop-cli`
> is intentionally **not** exposed here yet — this connector is read-only.
