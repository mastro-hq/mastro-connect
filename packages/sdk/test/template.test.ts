import { expect, test } from "bun:test";

import { renderTemplate, MissingTemplateValue } from "../src/index.ts";

test("plain placeholder preserves the resolved value's type", () => {
  expect(renderTemplate("${a}", { a: 42 })).toBe(42);
  expect(renderTemplate("${a}", { a: "x" })).toBe("x");
});

test("num: casts a numeric string to a JS number", () => {
  expect(renderTemplate("${num:a}", { a: "42" })).toBe(42);
  expect(renderTemplate("${num:a}", { a: "3.5" })).toBe(3.5);
});

test("num: leaves a non-numeric value as-is", () => {
  expect(renderTemplate("${num:a}", { a: "abc" })).toBe("abc");
});

test("unquote: strips one layer of surrounding double-quotes", () => {
  // LinkedIn stores JSESSIONID as `"ajax:123"`; csrf-token wants `ajax:123`.
  expect(renderTemplate("${unquote:auth.jsessionid}", { auth: { jsessionid: '"ajax:123"' } })).toBe(
    "ajax:123",
  );
});

test("unquote: passes through a value that has no surrounding quotes", () => {
  expect(renderTemplate("${unquote:a}", { a: "ajax:plain" })).toBe("ajax:plain");
});

test("unquote: only strips a matched leading+trailing pair, not inner quotes", () => {
  expect(renderTemplate("${unquote:a}", { a: 'a"b"c' })).toBe('a"b"c');
});

test("unquote: leaves a non-string value untouched", () => {
  expect(renderTemplate("${unquote:a}", { a: 7 })).toBe(7);
});

test("a missing value throws in strict mode", () => {
  expect(() => renderTemplate("${nope}", {})).toThrow(MissingTemplateValue);
});
