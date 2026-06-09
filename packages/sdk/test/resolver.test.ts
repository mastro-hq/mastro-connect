/** Path extraction + label↔wire resolution against Depop-shaped taxonomies. */
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";

import type { MastroResolve } from "@mastro/core";
import { extractPath, JsonCache, Resolver } from "../src/index.ts";

test("extractPath walks nested-object roots with [] wildcards", () => {
  const cat = {
    categoryFilters: [{ id: "menswear", children: [{ id: "tops", name: "Tops" }] }],
  };
  expect(extractPath(cat, "categoryFilters[].id")).toEqual(["menswear"]);
  expect(extractPath(cat, "categoryFilters[].children[].id")).toEqual(["tops"]);
  expect(extractPath(cat, "categoryFilters[].children[].name")).toEqual(["Tops"]);
});

test("extractPath walks bare-array roots and deep wildcards", () => {
  const sizes = [{ children: [{ children: [{ composite_id: "54.4", name: "M" }] }] }];
  expect(extractPath(sizes, "[].children[].children[].composite_id")).toEqual(["54.4"]);
  expect(extractPath(sizes, "[].children[].children[].name")).toEqual(["M"]);
});

test("Resolver maps label→wire, passes wire ids through, caches the fetch", async () => {
  const root = `/tmp/mastro-resolver-test-${process.pid}`;
  rmSync(root, { recursive: true, force: true });

  let fetches = 0;
  const fetcher = async () => {
    fetches++;
    return [{ children: [{ children: [{ composite_id: "54.4", name: "M" }] }] }];
  };
  const resolver = new Resolver(new JsonCache("test", root), fetcher);
  const spec: MastroResolve = {
    from: "sizeFilters",
    value_path: "[].children[].children[].composite_id",
    label_path: "[].children[].children[].name",
  };

  expect(await resolver.resolveValue(spec, "M")).toBe("54.4"); // label → wire
  expect(await resolver.resolveValue(spec, "54.4")).toBe("54.4"); // wire passthrough
  expect(await resolver.resolveValue(spec, "unknown")).toBe("unknown"); // graceful passthrough
  expect(fetches).toBe(1); // fetched once, then cached

  rmSync(root, { recursive: true, force: true });
});
