/**
 * x-mastro-extract: HTML → structured objects. The shapes exercised here
 * mirror what real connectors need — attribute-on-item (Amazon's data-asin),
 * first-match-wins text fields (current vs. strike-through price), fields
 * absent from some items, and attributes read off a matched descendant.
 */
import { expect, test } from "bun:test";

import type { MastroExtract } from "@mastro/core";

import { extractItems } from "../src/index.ts";
import { metaRefreshUrl } from "../src/util.ts";

const SPEC = {
  items: 'div[data-component-type="result"]',
  fields: {
    id: { attr: "data-id" },
    title: { selector: "h2 > span" },
    price: { selector: ".price .hidden" },
    image: { selector: "img.thumb", attr: "src" },
  },
} satisfies MastroExtract;

const PAGE = `
<html><body>
  <div data-component-type="result" data-id="A1">
    <h2><span>First   item
      title</span></h2>
    <span class="price"><span class="hidden">$9.99</span></span>
    <span class="price strike"><span class="hidden">$19.99</span></span>
    <img class="thumb" src="https://img/1.jpg">
  </div>
  <div data-component-type="banner">
    <h2><span>Not a result</span></h2>
  </div>
  <div data-component-type="result" data-id="A2">
    <h2><span>Second</span></h2>
  </div>
</body></html>`;

test("each items match becomes one object; non-matching siblings are skipped", async () => {
  const items = await extractItems(PAGE, SPEC);
  expect(items).toHaveLength(2);
  expect(items.map((i) => i["id"])).toEqual(["A1", "A2"]);
});

test("text fields take the first match and collapse whitespace", async () => {
  const [first] = await extractItems(PAGE, SPEC);
  expect(first?.["title"]).toBe("First item title");
  // Two .price .hidden matches — the strike-through one must not win or append.
  expect(first?.["price"]).toBe("$9.99");
});

test("attr fields read off descendants and missing fields stay null", async () => {
  const [first, second] = await extractItems(PAGE, SPEC);
  expect(first?.["image"]).toBe("https://img/1.jpg");
  expect(second?.["price"]).toBeNull();
  expect(second?.["image"]).toBeNull();
});

test("entities are decoded in text and attribute values", async () => {
  const page = `
    <div data-component-type="result" data-id="A&amp;B">
      <h2><span>Tom &amp; Jerry &#8243; &nbsp; stand</span></h2>
      <img class="thumb" src="https://img/1.jpg?a=1&amp;b=2">
    </div>`;
  const [item] = await extractItems(page, SPEC);
  expect(item?.["id"]).toBe("A&B");
  expect(item?.["title"]).toBe("Tom & Jerry ″ stand");
  expect(item?.["image"]).toBe("https://img/1.jpg?a=1&b=2");
});

test("a field value belongs to the item it appeared in, not a later one", async () => {
  const [first, second] = await extractItems(PAGE, SPEC);
  expect(second?.["title"]).toBe("Second");
  expect(first?.["title"]).not.toBe("Second");
});

// -- single-object mode (no `items`) -----------------------------------------

const DETAIL_SPEC = {
  fields: {
    asin: { selector: "input#ASIN", attr: "value" },
    title: { selector: "#productTitle" },
    price: { selector: "#corePrice .a-offscreen" },
    image: { selector: "#landingImage", attr: "src" },
    missing: { selector: "#nope" },
  },
} satisfies MastroExtract;

const DETAIL_PAGE = `
<html><body>
  <input id="ASIN" value="B00X4SCCFG">
  <span id="productTitle">  Monitor &amp; Stand
    Riser </span>
  <div id="corePrice"><span class="a-offscreen">$23.99</span></div>
  <div id="otherPrice"><span class="a-offscreen">$99.99</span></div>
  <img id="landingImage" src="https://img/main.jpg?a=1&amp;b=2">
</body></html>`;

test("single-object mode returns one object, not an array", async () => {
  const out = await extractItems(DETAIL_PAGE, DETAIL_SPEC);
  expect(Array.isArray(out)).toBe(false);
  expect(out).toMatchObject({ asin: "B00X4SCCFG" });
});

test("single-object fields are document-scoped, entity-decoded, whitespace-collapsed", async () => {
  const out = await extractItems(DETAIL_PAGE, DETAIL_SPEC);
  expect(out).toEqual({
    asin: "B00X4SCCFG",
    title: "Monitor & Stand Riser",
    // #corePrice scopes the price — the #otherPrice $99.99 must not leak in.
    price: "$23.99",
    image: "https://img/main.jpg?a=1&b=2",
    missing: null,
  });
});

// -- pattern + list fields (Amazon order history) ----------------------------

const ORDERS_SPEC = {
  items: "div.order-card",
  fields: {
    orderId: { selector: ".order-id span" },
    total: { selector: ".col:nth-child(2) .value" },
    items: {
      each: 'a[href*="/dp/"]',
      fields: {
        asin: { attr: "href", pattern: "/dp/(\\w{10})" },
        title: { selector: "img", attr: "alt" },
        price: { selector: ".price" },
      },
    },
  },
} satisfies MastroExtract;

const ORDERS_PAGE = `
<html><body>
  <div class="order-card">
    <div class="row">
      <div class="col"><span class="value">May 1, 2026</span></div>
      <div class="col"><span class="value">$30.00</span></div>
    </div>
    <div class="order-id"><span>111-1</span></div>
    <a href="/dp/B000000001?ref=x"><img alt="Mug &amp; Saucer"><span class="price">$10.00</span></a>
    <a href="/gp/buyagain?asin=B000000009">Buy it again</a>
    <a href="/dp/B000000002?ref=x"><img alt="Kettle"></a>
  </div>
  <div class="order-card">
    <div class="order-id"><span>111-2</span></div>
  </div>
  <div class="order-card">
    <div class="order-id"><span>111-3</span></div>
    <a href="/dp/B000000003"><img alt="Lamp"></a>
  </div>
</body></html>`;

test("a list field yields one entry per `each` match, scoped to its own item", async () => {
  const orders = await extractItems(ORDERS_PAGE, ORDERS_SPEC);
  expect(orders.map((o) => o["orderId"])).toEqual(["111-1", "111-2", "111-3"]);
  expect(orders[0]?.["items"]).toEqual([
    { asin: "B000000001", title: "Mug & Saucer", price: "$10.00" },
    { asin: "B000000002", title: "Kettle", price: null },
  ]);
  // An item with no entries gets an empty list (not null), and entries never
  // leak into the neighbouring item.
  expect(orders[1]?.["items"]).toEqual([]);
  expect(orders[2]?.["items"]).toEqual([{ asin: "B000000003", title: "Lamp", price: null }]);
});

test("nth-child picks a sibling column; scalar fields sit beside list fields", async () => {
  const [first, second] = await extractItems(ORDERS_PAGE, ORDERS_SPEC);
  expect(first?.["total"]).toBe("$30.00");
  expect(second?.["total"]).toBeNull();
});

test("pattern keeps capture group 1; a non-matching value is skipped for a later match", async () => {
  const spec = {
    items: "li",
    fields: {
      id: { selector: "a", attr: "href", pattern: "/dp/(\\w+)" },
      whole: { selector: "span", pattern: "\\d+ stars" },
      none: { selector: "span", pattern: "^never$" },
    },
  } satisfies MastroExtract;
  const page = `<ul><li>
    <a href="/help">help</a><a href="/dp/B0ABC">product</a>
    <span>rated 4 stars overall</span>
  </li></ul>`;
  const [item] = await extractItems(page, spec);
  expect(item).toEqual({ id: "B0ABC", whole: "4 stars", none: null });
});

test("list fields also work in single-object mode (document-scoped)", async () => {
  const spec = {
    fields: {
      title: { selector: "h1" },
      links: { each: "nav a", fields: { href: { attr: "href" } } },
    },
  } satisfies MastroExtract;
  const page = `<h1>Page</h1><nav><a href="/a">A</a><a href="/b">B</a></nav><a href="/c">C</a>`;
  const out = await extractItems(page, spec);
  expect(out).toEqual({ title: "Page", links: [{ href: "/a" }, { href: "/b" }] });
});

// -- metaRefreshUrl (follow_html_refresh) ------------------------------------

test("metaRefreshUrl reads an Akamai-style interstitial, entities decoded", () => {
  const stub = `<!DOCTYPE html><html><head> <meta charset="utf-8">
    <meta http-equiv="refresh" content="5; URL='/s?k=laptop+stand&amp;bm-verify=AAQAAAAN_8a'">
    </head><body></body></html>`;
  expect(metaRefreshUrl(stub)).toBe("/s?k=laptop+stand&bm-verify=AAQAAAAN_8a");
});

test("metaRefreshUrl handles unquoted targets and ignores everything else", () => {
  expect(metaRefreshUrl('<meta http-equiv="refresh" content="0; url=https://x.test/next">')).toBe(
    "https://x.test/next",
  );
  expect(metaRefreshUrl("<html><body>just a page</body></html>")).toBeUndefined();
  expect(metaRefreshUrl('{"objects": []}')).toBeUndefined();
  // A real (large) document mentioning a refresh in content must not match.
  expect(metaRefreshUrl("x".repeat(20_000) + '<meta http-equiv="refresh" content="0; url=/y">')).toBeUndefined();
});

test("a selector list stays inside its item (no field borrowed from elsewhere on the page)", async () => {
  const spec = {
    items: "div.card",
    fields: { name: { selector: "b" }, price: { selector: ".p2, .price" } },
  } satisfies MastroExtract;
  const page = `
    <div class="card"><b>A</b><span class="price">$1</span></div>
    <div class="card"><b>B</b></div>
    <footer><span class="price">$999</span></footer>`;
  const items = await extractItems(page, spec);
  expect(items).toEqual([{ name: "A", price: "$1" }, { name: "B", price: null }]);
});
