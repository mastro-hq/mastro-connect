# Skill: get Amazon product detail

Agent-facing playbook for reading one product's detail via `mastro`.

## When to use

The user wants the full facts on a specific product — price, rating, stock,
seller, brand — given an ASIN (or a product they just found via `search`).
Good for "is this in stock?", "who's the seller?", "what's the exact price?".

## Preconditions

- `mastro login amazon` has been run (check `mastro status --json` →
  `amazon.state == "active"`). If absent, ask the user to run it.
- Replay runs inside a logged-in amazon.com browser tab via the mastro
  extension (mastro opens the tab if needed).

## Command

```bash
mastro amazon detail <asin> --json
```

`<asin>` is the 10-character product id — the `asin` field from `search`
results, or the `/dp/<asin>` segment of a product URL. Always pass `--json`.

## Reading the result

A single object (not an array — detail is one product), extracted from the
page (there is no JSON API behind it):

- `asin`, `title`, `byline` (brand/store), `price` (e.g. `"$23.99"`, the
  current buy-box offer), `rating` (`"4.6 out of 5 stars"`), `reviews`
  (`"(24,978)"`), `availability` (`"In Stock"`), `merchant` (who sells/ships),
  `image`.
- Missing fields are `null` (e.g. `price` on an out-of-stock or
  variation-only item).

## Tips

- Values are display strings, not numbers — parse `price`/`rating` before
  comparing or doing math.
- The `price` is the current buy-box offer; a product may have cheaper Used
  offers not shown here. `detail` reflects the default (New) buy box.
- To then buy it, hand the same `asin` to `mastro amazon order` (see the order
  skill — and confirm with the user first; it spends money).
- Mostly-`null` output on a real product means Amazon changed the detail
  markup — see the drift notes in the provider README.
- Respect the rate limit (12 req/min).
