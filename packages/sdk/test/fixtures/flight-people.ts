/**
 * A synthetic React Server Components (Flight) stream that mirrors the shape of
 * LinkedIn's people-search SRP response — without shipping real members' data.
 *
 * It reproduces the structural traits the extractor must handle, captured from
 * a live response:
 *   - the newline-delimited `<id>:<payload>` row framing, with `I[...]` import
 *     rows the parser must skip and one array row holding the page tree,
 *   - result cards tagged `viewTrackingSpecs.viewName == "people-search-result"`,
 *     wrapping text under both `children` and `textProps.children`,
 *   - a `NavigateToUrl` action nested deep in the card (the profile link),
 *   - a connection-distance badge ("• 3rd+") interleaved with the real text,
 *   - a card whose avatar repeats the name as alt text (must be collapsed),
 *   - a percent-encoded non-Latin profile slug (must be decoded),
 *   - a non-card element with its own viewName (must be ignored).
 */

/** Build a `NavigateToUrl` action node for a profile path. */
function navTo(url: string): unknown {
  return {
    $type: "proto.sdui.actions.core.Navigate",
    value: { content: { $case: "url", url: { $type: "proto.sdui.actions.core.NavigateToUrl", url } } },
  };
}

/** A text node carrying one visible string under `textProps.children`. */
function text(value: string): unknown {
  return ["$", "$L7", null, { textProps: { fontWeight: "bold", children: [value] } }];
}

/** A people-search-result card: name, optional avatar-alt repeat, distance, headline, location. */
function peopleCard(opts: {
  url: string;
  name: string;
  headline: string;
  location: string;
  /** Some cards echo the name as the avatar's alt text just before the title. */
  avatarRepeatsName?: boolean;
  /** Extra trailing lines (e.g. "701 followers", "Current: …"). */
  extra?: string[];
}): unknown {
  const lines: unknown[] = [];
  if (opts.avatarRepeatsName) lines.push(["$", "div", null, { children: [opts.name] } ]);
  lines.push(text(opts.name));
  lines.push(["$", "span", "dist", { children: [" • 3rd+"] }]);
  lines.push(text(opts.headline));
  lines.push(text(opts.location));
  for (const e of opts.extra ?? []) lines.push(text(e));

  return [
    "$",
    "$L2",
    null,
    {
      viewTrackingSpecs: { viewName: "people-search-result", interactionTypes: ["SHORT_PRESS"] },
      // The click action (with the profile NavigateToUrl) sits beside the visible content.
      children: [
        "$",
        "$L4",
        null,
        {
          triggers: [{ action: { actions: [navTo(opts.url)] } }],
          children: ["$", "div", null, { children: lines }],
        },
      ],
    },
  ];
}

/** The page tree: a header (non-card), then the result cards. */
const pageTree: unknown = [
  "$",
  "div",
  null,
  {
    children: [
      // A non-card element with a different viewName — must be ignored.
      ["$", "$L2", null, { viewTrackingSpecs: { viewName: "search-results-header" }, children: ["People"] }],
      peopleCard({
        url: "https://www.linkedin.com/in/ada-lovelace/",
        name: "Ada Lovelace",
        headline: "Mathematician at Analytical Engine Co.",
        location: "London, England, United Kingdom",
      }),
      peopleCard({
        url: "https://www.linkedin.com/in/grace-hopper-7b3/",
        name: "Grace Hopper",
        headline: "Rear Admiral | Compiler Pioneer",
        location: "Arlington, Virginia, United States",
        avatarRepeatsName: true,
        extra: ["12,043 followers"],
      }),
      peopleCard({
        // Percent-encoded non-Latin slug (Arabic) — must decode to the raw slug.
        url: "https://www.linkedin.com/in/%D8%B9%D9%84%D9%8A-a434b5115/en/",
        name: "Ali H.",
        headline: "منتج في الهندسة",
        location: "Riyadh, Saudi Arabia",
      }),
    ],
  },
];

/**
 * The full Flight stream: import rows the parser skips, a string row, then the
 * page tree row. `0:` is intentionally not first to prove row id doesn't matter.
 */
export const FLIGHT_PEOPLE_STREAM = [
  '1:I["030d6035cb3a997efb1cff7a008d2f89",[],"default"]',
  '2:I["f54a4d9f94904eb227a6c1307124edd6",[],"ClientComponent"]',
  '12:"$Sreact.fragment"',
  `0:${JSON.stringify(pageTree)}`,
].join("\n");
