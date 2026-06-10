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
