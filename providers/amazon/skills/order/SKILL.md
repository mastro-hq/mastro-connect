---
name: mastro-amazon-order
description: Place a real Amazon Buy Now order for an ASIN via the mastro CLI — spends actual money on the account's default address and payment method. Use ONLY when the user explicitly asks to buy a specific product; always dry-run and confirm first.
---

# Order an Amazon product (Buy Now)

Agent-facing playbook for placing a **real, money-spending** Buy Now order.
If `mastro` is not on PATH, invoke it as `npx -y mastro-connect`.

## ⚠️ This spends real money

`mastro amazon order <asin>` places an actual order: the account's default
shipping address, default payment method, quantity 1 — exactly like clicking
"Buy Now" then "Place your order". It charges the user's card and is not
reversible from here (they'd cancel/return it on amazon.com).

**Rules:**

1. **Never order without an explicit, specific go-ahead from the user** for
   that exact product. "Find me a cheap stand" is not consent to buy one.
2. **Always `--dry-run` first** and show the user what will happen.
3. Confirm the ASIN maps to the product the user means (use `detail` to
   verify title + price first).

## Preconditions

- `mastro login amazon` is active (`mastro status --json` →
  `amazon.state == "active"`).
- A logged-in amazon.com browser tab (the extension provides it).
- The account has a default address and default payment method set up
  (Buy Now uses them with no prompts). If the user has never configured these,
  the order step can fail — tell them to set defaults on amazon.com once.

## Steps

1. Verify the product:

   ```bash
   mastro amazon detail <asin> --json
   ```

   Show the user the `title`, `price`, `merchant`, `availability`.

2. Preview the order without charging anything:

   ```bash
   mastro amazon order <asin> --dry-run
   ```

   This prints every planned request (auth redacted) through the place-order
   step **without sending the irreversible POST**. Confirm the flow looks
   right (the buynow + place-order URLs target the right ASIN).

3. Only after explicit user confirmation, place it:

   ```bash
   mastro amazon order <asin> --json
   ```

## Reading the result

On success, `order` returns the bare Amazon **order id** (e.g.
`106-9975173-2540207`). Report it to the user — they can track or cancel it at
`https://www.amazon.com/gp/css/order-history`. Reaching a returned order id
means the order was placed; a failure throws an error instead.

## If it fails

- An error mentioning a form not matching (`#addToCart` / `form[name='spc']`)
  means Amazon changed the checkout markup — see the provider README drift
  notes; don't retry blindly.
- A failure at the place-order step with the earlier steps succeeding often
  means no default address/payment is set, or the item isn't Buy-Now eligible
  (e.g. needs options selected). Fall back to telling the user to complete it
  on amazon.com.
- Do **not** loop-retry an order — a retry could place a duplicate. Surface
  the error and stop.
