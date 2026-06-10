/**
 * x-mastro-form: replaying a server-rendered <form> as a urlencoded body. The
 * shapes here mirror the Amazon Buy Now pipeline — a form full of hidden
 * fields plus a CSRF token, duplicate `#addToCart` buy boxes (only the first
 * counts), submit buttons that must be excluded, and the few overrides a real
 * submission adds.
 */
import { expect, test } from "bun:test";

import { encodeForm, parseFormFields } from "../src/form.ts";

test("captures named controls, skips buttons, includes only checked boxes", async () => {
  const html = `<form id="f">
    <input type="hidden" name="anti-csrftoken-a2z" value="tok/+=123">
    <input type="text" name="qty" value="1">
    <input type="submit" name="submit.add" value="Add">
    <input type="checkbox" name="gift" value="yes" checked>
    <input type="checkbox" name="insure" value="yes">
    <input name="novalue">
    <input value="anon">
    <select name="ship"><option value="std">Standard</option><option value="exp" selected>Express</option></select>
    <textarea name="note"> hello </textarea>
  </form>`;
  const fields = await parseFormFields(html, "#f");
  expect(fields).toEqual([
    { name: "anti-csrftoken-a2z", value: "tok/+=123" },
    { name: "qty", value: "1" },
    { name: "gift", value: "yes" }, // checked
    // insure unchecked → omitted; the no-name input → omitted; submit → omitted
    { name: "novalue", value: "" }, // named but valueless → present, empty
    { name: "ship", value: "exp" }, // selected option
    { name: "note", value: " hello " }, // textarea text, not collapsed
  ]);
});

test("a select with no selected option defaults to its first option", async () => {
  const html = `<form id="f"><select name="s"><option value="a">A</option><option value="b">B</option></select></form>`;
  const [field] = (await parseFormFields(html, "#f"))!;
  expect(field).toEqual({ name: "s", value: "a" });
});

test("only the first matching form is read (duplicate ids, Amazon buy boxes)", async () => {
  // Two #addToCart forms — a New and a Used buy box with different prices,
  // offers, and tokens. A browser submits the first; so must we.
  const html = `
    <form id="addToCart">
      <input name="anti-csrftoken-a2z" value="NEW-token">
      <input name="price" value="23.99">
      <input name="offer" value="NEW-offer">
    </form>
    <form id="addToCart">
      <input name="anti-csrftoken-a2z" value="USED-token">
      <input name="price" value="20.85">
      <input name="offer" value="USED-offer">
    </form>`;
  const fields = await parseFormFields(html, "#addToCart");
  expect(fields).toEqual([
    { name: "anti-csrftoken-a2z", value: "NEW-token" },
    { name: "price", value: "23.99" },
    { name: "offer", value: "NEW-offer" },
  ]);
});

test("HTML entities in field values are decoded", async () => {
  const html = `<form id="f"><input name="u" value="/a?x=1&amp;y=2"><input name="t" value="Tom &amp; Jerry"></form>`;
  const fields = await parseFormFields(html, "#f");
  expect(fields).toEqual([
    { name: "u", value: "/a?x=1&y=2" },
    { name: "t", value: "Tom & Jerry" },
  ]);
});

test("no matching form returns undefined (caller fails loudly)", async () => {
  expect(await parseFormFields("<div>no form here</div>", "#addToCart")).toBeUndefined();
});

test("encodeForm urlencodes values and applies set in place / unset", async () => {
  const fields = [
    { name: "anti-csrftoken-a2z", value: "a/b+c=" },
    { name: "submit.add-to-cart", value: "Add to cart" },
    { name: "quantity", value: "1" },
  ];
  const body = encodeForm(fields, { "submit.buy-now": "", quantity: "2" }, ["submit.add-to-cart"]);
  const params = new URLSearchParams(body);
  // CSRF token's reserved chars are percent-encoded.
  expect(body).toContain("anti-csrftoken-a2z=a%2Fb%2Bc%3D");
  // unset drops the add-to-cart button; set overrides quantity in place.
  expect(params.has("submit.add-to-cart")).toBe(false);
  expect(params.get("quantity")).toBe("2");
  // a set key absent from the fields is appended as a new field.
  expect(params.get("submit.buy-now")).toBe("");
});

test("encodeForm keeps an overridden field in its original position", async () => {
  const fields = [
    { name: "a", value: "1" },
    { name: "b", value: "2" },
    { name: "c", value: "3" },
  ];
  // Overriding b must not move it to the end; new field z appends.
  expect(encodeForm(fields, { b: "X", z: "9" })).toBe("a=1&b=X&c=3&z=9");
});
