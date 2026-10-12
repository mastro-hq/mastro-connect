import { expect, test } from "bun:test";

import { flagFromParameter } from "../src/args.ts";

test("a required parameter the spec defaults isn't a required flag", () => {
  const flag = flagFromParameter({
    name: "user_id",
    in: "path",
    required: true,
    schema: { type: "string", default: "${auth.user_id}" },
  });
  expect(flag.required).toBe(false);
});

test("a required parameter without a default stays required", () => {
  expect(flagFromParameter({ name: "id", in: "path", required: true, schema: { type: "string" } }).required).toBe(true);
});
