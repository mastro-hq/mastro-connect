/**
 * x-mastro-extract `format: "flight"` — React Server Components stream → cards.
 *
 * Exercises the traits a real SDUI search response has (see the fixture):
 * skipping `I[...]` import rows to find the page tree, mapping ordered visible
 * text onto name/headline/location roles, collapsing an avatar's repeated name,
 * decoding a percent-encoded profile slug, pulling the distance badge by regex,
 * and ignoring elements with a different viewName.
 */
import { expect, test } from "bun:test";

import type { MastroExtractFlight } from "@mastro/core";

import { extractFlight } from "../src/flight.ts";
import { FLIGHT_PEOPLE_STREAM } from "./fixtures/flight-people.ts";

/** The exact spec the LinkedIn `search-people` op declares. */
const SPEC = {
  format: "flight",
  item: "people-search-result",
  fields: {
    name: { from: "text", role: "name" },
    headline: { from: "text", role: "headline" },
    location: { from: "text", role: "location" },
    distance: { from: "text", match: "^•" },
    url: { from: "nav-url" },
    publicId: { from: "nav-url", pattern: "/in/([^/?]+)" },
  },
} satisfies MastroExtractFlight;

test("extracts one object per people-search-result card (header ignored)", () => {
  const people = extractFlight(FLIGHT_PEOPLE_STREAM, SPEC);
  expect(people).toHaveLength(3);
});

test("maps ordered visible text onto name/headline/location", () => {
  const [ada] = extractFlight(FLIGHT_PEOPLE_STREAM, SPEC);
  expect(ada).toEqual({
    name: "Ada Lovelace",
    headline: "Mathematician at Analytical Engine Co.",
    location: "London, England, United Kingdom",
    distance: "• 3rd+",
    url: "https://www.linkedin.com/in/ada-lovelace/",
    publicId: "ada-lovelace",
  });
});

test("collapses an avatar's repeated name and tolerates trailing lines", () => {
  const grace = extractFlight(FLIGHT_PEOPLE_STREAM, SPEC)[1];
  // The name is echoed by the avatar before the title; the headline must still
  // be the real headline, not the repeated name.
  expect(grace?.name).toBe("Grace Hopper");
  expect(grace?.headline).toBe("Rear Admiral | Compiler Pioneer");
  expect(grace?.location).toBe("Arlington, Virginia, United States");
});

test("decodes a percent-encoded non-Latin profile slug", () => {
  const ali = extractFlight(FLIGHT_PEOPLE_STREAM, SPEC)[2];
  expect(ali?.url).toBe("https://www.linkedin.com/in/%D8%B9%D9%84%D9%8A-a434b5115/en/");
  expect(ali?.publicId).toBe("علي-a434b5115");
});

test("a body that isn't a Flight page yields no cards", () => {
  expect(extractFlight("not a flight stream", SPEC)).toEqual([]);
  expect(extractFlight("", SPEC)).toEqual([]);
});

test("finds cards in a later row, not just the first array row", () => {
  // A full SRP page load splits the tree across rows: an app-shell array row
  // comes first, the results render into a later row. The extractor must search
  // every row, not return on the first array it parses (regression: the
  // original parser stopped at row 0 and missed the cards entirely).
  const shell = ["$", "div", null, { children: [["$", "$L1", null, { role: "AppShell" }]] }];
  const card = [
    "$",
    "$L2",
    null,
    {
      viewTrackingSpecs: { viewName: "people-search-result" },
      children: [
        "$",
        "$L4",
        null,
        {
          triggers: [
            {
              action: {
                actions: [
                  {
                    $type: "proto.sdui.actions.core.Navigate",
                    value: {
                      content: {
                        $case: "url",
                        url: { $type: "proto.sdui.actions.core.NavigateToUrl", url: "https://www.linkedin.com/in/late-row/" },
                      },
                    },
                  },
                ],
              },
            },
          ],
          children: ["$", "$L7", null, { textProps: { children: ["Later Row Person"] } }],
        },
      ],
    },
  ];
  const stream = [
    '1:I["abc",[],"Screen"]', // import row — skipped
    `0:${JSON.stringify(shell)}`, // app shell, parses first but has no cards
    `3b:${JSON.stringify([shell, card])}`, // cards live here
  ].join("\n");

  const people = extractFlight(stream, SPEC);
  expect(people).toHaveLength(1);
  expect(people[0]?.name).toBe("Later Row Person");
  expect(people[0]?.publicId).toBe("late-row");
});

test("the same card referenced from two rows is deduped by URL", () => {
  const card = [
    "$",
    "$L2",
    null,
    {
      viewTrackingSpecs: { viewName: "people-search-result" },
      children: [
        "$",
        "$L4",
        null,
        {
          triggers: [
            {
              action: {
                actions: [
                  {
                    $type: "proto.sdui.actions.core.NavigateToUrl",
                    url: "https://www.linkedin.com/in/dupe/",
                  },
                ],
              },
            },
          ],
          children: ["Dupe Person"],
        },
      ],
    },
  ];
  const stream = [`0:${JSON.stringify([card])}`, `1:${JSON.stringify([card])}`].join("\n");
  expect(extractFlight(stream, SPEC)).toHaveLength(1);
});

test("every declared field is present even when a card lacks a source", () => {
  // A card with no NavigateToUrl and no text still yields all keys, nulled.
  const emptyCard = `0:${JSON.stringify([
    "$",
    "div",
    null,
    { children: [["$", "$L2", null, { viewTrackingSpecs: { viewName: "people-search-result" }, children: [] }]] },
  ])}`;
  const [card] = extractFlight(emptyCard, SPEC);
  expect(card).toEqual({
    name: null,
    headline: null,
    location: null,
    distance: null,
    url: null,
    publicId: null,
  });
});
