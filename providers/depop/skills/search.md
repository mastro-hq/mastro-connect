# Skill: search Depop

Agent-facing playbook for searching Depop listings via `mastro`.

## When to use

The user wants to find, browse, compare, or price-check secondhand fashion
items on Depop ("what's a fair price for a vintage Carhartt jacket on Depop?",
"find me black Nike trainers size 9").

## Preconditions

- `mastro login depop` has been run (check `mastro status --json` →
  `depop.state == "active"`). If expired/absent, ask the user to run
  `mastro login depop` (it needs the browser).

## Command

```bash
mastro depop search "<query>" [filters...] --json
```

Run `mastro depop search --help` for the live flag list (it's generated from the
spec). The filters mirror the website's filter bar:

- `--sizes`, `--brandIds`, `--categories` — repeatable; accept an id **or** a
  label (e.g. `--sizes M`), resolved automatically.
- `--colours`, `--conditions` — repeatable enums (e.g. `--conditions used_good`).
- `--priceMin` / `--priceMax`, `--isDiscounted`, `--sortBy`, `--limit`, `--after`.
- Always pass `--json` so you get structured results, not pretty text.
- The first positional is the query — no `--what` flag needed.

## Reading results

The JSON has an `objects` array. Useful fields per product (verify against live
output, shapes drift): `pricing.current_price.total_price`, `brand_name`,
`sizes`, `slug`, `preview.formats`, `is_boosted`, `like_count`. Build the
listing URL as `https://www.depop.com/products/<slug>/`.

## Tips

- For a price estimate, search the specific item, filter out `isSold` if you
  only want live listings, and report the median of the first page.
- If you get an auth error, the session expired — tell the user to re-run
  `mastro login depop`.
- Respect the rate limit (30 req/min); batch thoughtfully.
