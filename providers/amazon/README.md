# Amazon connector

Searches Amazon's retail site, reads product details, and places Buy Now
orders — all using your logged-in browser session.

```bash
mastro login amazon
mastro amazon search "laptop stand"
mastro amazon search "laptop stand" --s price-asc-rank --low-price 20 --high-price 60
mastro amazon search "usb c hub" --i electronics --page 2 --json

mastro amazon detail B00X4SCCFG               # one product by ASIN

mastro amazon order B00X4SCCFG --dry-run      # preview the order (no charge)
mastro amazon order B00X4SCCFG                # ⚠️ places a real order
```

The connector is described by [`openapi.yaml`](openapi.yaml) (a valid OpenAPI 3.1
document) plus [`auth.manifest.json`](auth.manifest.json) for the browser capture.

## How auth works

Amazon has no bearer token — the session **is** the cookie jar on `amazon.com`:

| Cookie                  | Use                                        |
| ----------------------- | ------------------------------------------ |
| `at-main`               | Auth token (**HttpOnly**) — the logged-in marker |
| `sess-at-main`/`x-main` | Companion auth cookies                     |
| `session-id`/`ubid-main`| Session + device ids (exist even logged out) |

`mastro login amazon` opens amazon.com, waits until `at-main` and `session-id`
exist, and stores the full cookie header (redacted in logs). There is no
`verify` operation: search answers `200` even logged-out, so there's no cheap
"is the session live" probe.

## How replay works

Amazon fingerprints non-browser clients and serves them a **503 robot check**,
so the spec sets `x-mastro-replay.via_browser: true` and mastro runs requests
**inside your logged-in amazon.com tab** via the extension (same path as Depop
— see [`docs/BROWSER-PROXY.md`](../../docs/BROWSER-PROXY.md)).

Even in-tab `fetch()`es get flagged by **Akamai Bot Manager**: instead of the
page, Amazon answers with a ~2.5 KB stub that meta-refreshes to the same URL
plus a one-time `bm-verify` token. The spec sets
`x-mastro-replay.follow_html_refresh: true`, so mastro chases that refresh
once and gets the real page (a real browser navigation does the same thing,
which is why you never see it).

**Requirement:** the mastro extension must be installed/enabled and you need an
amazon.com tab (mastro opens one if needed).

## Why HTML extraction (x-mastro-extract)

Amazon's retail pages have **no JSON API**. Search results exist only
server-rendered in `GET /s?k=...`; even the site's own ajax refinement
endpoint (`POST /s/query`, used for pagination clicks) returns `&&&`-delimited
`["dispatch", <widget>, {html: ...}]` chunks whose payload is HTML fragments.
Product detail is the same story. So `search` and `detail` declare
`x-mastro-extract`: the SDK streams the page through `HTMLRewriter` and turns
it into structured data.

**Search** (array mode) — each `div[data-component-type="s-search-result"]`
becomes one object:

| Field       | Source                                              | Example |
| ----------- | --------------------------------------------------- | ------- |
| `asin`      | `data-asin` on the result card                      | `B00X4SCCFG` |
| `title`     | `h2 span` text                                      | `Amazon Basics Height Adjustable…` |
| `price`     | first `.a-price .a-offscreen` (current offer; the strike-through list price comes second and is ignored) | `$23.99` |
| `rating`    | star icon alt text                                  | `4.6 out of 5 stars` |
| `reviews`   | ratings-count link text                             | `(24.9K)` |
| `image`     | `img.s-image` `src`                                 | `https://m.media-amazon.com/...` |
| `url`       | first result link `href`, relative to amazon.com — a `/dp/...` product path, or a `/sspa/click...` redirect for sponsored slots | `/AmazonBasics-…/dp/B00X4SCCFG/...` |
| `sponsored` | `"Sponsored"` label text; `null` for organic results | `Sponsored` |

**Detail** (single-object mode — `x-mastro-extract` with no `items` selector,
so the whole page is one object) from `GET /dp/<asin>`:

| Field          | Source                                  | Example |
| -------------- | --------------------------------------- | ------- |
| `asin`         | `input#ASIN` value                      | `B00X4SCCFG` |
| `title`        | `#productTitle` text                    | `Amazon Basics … Monitor Stand …` |
| `byline`       | `#bylineInfo` text                      | `Visit the Amazon Basics Store` |
| `price`        | `#corePrice_feature_div .a-offscreen`   | `$23.99` |
| `rating`       | `#acrPopover .a-icon-alt`               | `4.6 out of 5 stars` |
| `reviews`      | `#acrCustomerReviewText`                | `(24,978)` |
| `availability` | `#availability span`                    | `In Stock` |
| `merchant`     | `#merchant-info`                        | `Sold by Amazon Resale …` |
| `image`        | `#landingImage` `src`                   | `https://m.media-amazon.com/...` |

Fields that don't appear (e.g. price on an out-of-stock item) are `null`.

## How ordering works (x-mastro-workflow + x-mastro-form)

`order` places a **real Buy Now order with all defaults** — the account's
default shipping address, default payment method, quantity 1, exactly what
clicking "Buy Now" then "Place your order" does. There is no JSON ordering
API; each step is gated behind a server-rendered form carrying a one-time CSRF
token, so the `order` workflow uses `x-mastro-form` to **replay those forms
verbatim** (the same field set a browser would submit):

1. `GET /dp/<asin>` → the page embeds the `#addToCart` Buy Now form (CSRF
   token, offer id, ~38 hidden fields). A detail page renders several
   `#addToCart` buy boxes (New, Used, …); only the **first** is replayed, like
   the browser.
2. `POST /checkout/entry/buynow` with that form + the clicked button
   (`submit.buy-now`) → the single-page-checkout (SPC) review page, which
   carries the place-order form and a **fresh** CSRF token. The `purchaseId`
   in its action URL is the order id.
3. `POST /checkout/p/<purchaseId>/spc/place-order` with the SPC form (its one
   field is the fresh token) + the markers the page's JS sets on click
   (`placeYourOrder1=1`, `hasWorkingJavascript=1`) → `302` to the thank-you
   page. **This is the irreversible, money-spending step.**

`order` returns the bare order id (e.g. `106-9975173-2540207`). Reaching that
point means place-order returned success; a failed order throws.

> **Always `--dry-run` first.** It prints every planned request (auth redacted)
> through step 3 without sending the irreversible POST, so you can confirm the
> ASIN and the flow before spending money.

## Commands

| Command  | Endpoint / flow                          |
| -------- | ---------------------------------------- |
| `search` | `GET https://www.amazon.com/s?k=...` + HTML extraction (array) |
| `detail` | `GET https://www.amazon.com/dp/<asin>` + HTML extraction (single object) |
| `order`  | Buy Now workflow: detail form → `/checkout/entry/buynow` → `/spc/place-order` |

### Search flags

Flags are the wire params of `/s`, exactly as the website uses them:

| Flag           | Wire param  | Notes |
| -------------- | ----------- | ----- |
| `--k`          | `k`         | required search text (also the first positional) |
| `--i`          | `i`         | department alias, e.g. `electronics`, `fashion` |
| `--page`       | `page`      | 1-based; ~22 items per page |
| `--s`          | `s`         | relevanceblender \| price-asc-rank \| price-desc-rank \| review-rank \| date-desc-rank \| exact-aware-popularity-rank |
| `--low-price`  | `low-price` | numeric |
| `--high-price` | `high-price`| numeric |
| `--rh`         | `rh`        | raw refinement string from the site's filter URLs (advanced) |

## Status & drift

`status: reverse_engineered` — observed from browser traffic, can change
without notice. The extraction selectors and the order form selectors are the
fragile part (they're Amazon's CSS/markup, not an API contract).

**`search` returns `[]` or items full of `null`s** —

1. Open amazon.com, run a search, and check whether result cards still carry
   `data-component-type="s-search-result"` / `data-asin`.
2. Diff the card's markup against the `x-mastro-extract` selectors in
   `openapi.yaml` and update them.

**`detail` returns mostly `null`s** — open `/dp/<asin>` and diff the
`#productTitle` / `#corePrice_feature_div` / `#acrPopover` selectors against the
page; Amazon A/B-tests detail layouts, so a field may move.

**`order` fails** —

- `x-mastro-form: no form matched "#addToCart"` (or `form[name='spc']`) → the
  form id/name changed. Re-derive from the live page: the Buy Now form is the
  one whose buy-now button has `formaction="/checkout/entry/buynow"`; the SPC
  form is `name="spc"` with `action=".../spc/place-order"`.
- The order doesn't complete → run `--dry-run` and inspect the planned bodies.
  The most likely drift is the `/checkout/entry/buynow` query params or the
  place-order markers (`placeYourOrder1`, `hasWorkingJavascript`).

**`503` on every attempt despite the browser path** usually means the tab is
gone — re-run with an amazon.com tab open, or `mastro login amazon`.

> Reverse-engineered live on 2026-06-09. `search` was captured first (the
> initial HAR was empty); `detail` and `order` were added from a later HAR
> that contained a full Buy Now checkout (`/checkout/.../spc/place-order` +
> thank-you page), with the Buy Now form / SPC choreography traced live from a
> logged-in session. The sort enum (`s` values) was read from the sort
> dropdown's `<option>`s; the `/s/query` ajax endpoint was probed and rejected
> as a transport because its payload is HTML-in-JSON dispatch chunks keyed to a
> per-page `X-Amazon-s-swrs-version` checksum. The Buy Now form is replayed
> verbatim (proven byte-identical to the browser's own `FormData`); the full
> pipeline was validated live up to — but not including — the irreversible
> place-order POST.
