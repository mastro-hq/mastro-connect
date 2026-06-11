/**
 * x-mastro-extract `format: "flight"` — structured cards out of a React Server
 * Components (Flight) stream.
 *
 * Some apps have moved their search/list UIs onto a server-driven-UI layer:
 * instead of a JSON API (or even server-rendered HTML), the endpoint answers
 * with a Flight stream — the wire format React uses to ship a server-rendered
 * component tree to the client. LinkedIn's people search is one: its SRP POST
 * returns a Flight body, not Voyager JSON.
 *
 * The wire format is newline-delimited rows, each `<id>:<payload>` where the
 * payload is JSON. Most rows are module/import descriptors; one big row is the
 * page itself — a deeply nested tree of element tuples shaped like a serialized
 * React element: `["$", tag, key, props]`. Visible text lives in a node's
 * `children` (or `props.textProps.children`); a click target is a
 * `NavigateToUrl` action buried in the props.
 *
 * There is no markup to run CSS against, so extraction walks the tree:
 *   1. find every *card* — an element whose `viewTrackingSpecs.viewName`
 *      matches the spec's `item`,
 *   2. within each card collect the navigation URL and the ordered visible
 *      text, then map those onto the declared fields (by URL pattern, by
 *      semantic role, or by regex).
 *
 * Robust to the variants seen in real responses: a name that repeats as an
 * avatar's alt text (collapsed), a connection-distance badge like "• 3rd+"
 * (skipped for role mapping), and percent-encoded non-Latin profile slugs
 * (decoded).
 */
import type { FlightField, FlightTextField, MastroExtractFlight } from "@mastro/core";

import type { ExtractedItem } from "./extract.ts";

/** A serialized React element: `["$", tag, key, props]`. */
type FlightElement = [marker: "$", tag: FlightNode, key: FlightNode, props: FlightObject];

/** Any node in the Flight tree: an element, a list of nodes, a string, or data. */
type FlightNode = FlightElement | FlightNode[] | string | number | boolean | null | FlightObject;
type FlightObject = { [key: string]: FlightNode };

/** A `props` value read as a nested node (children, textProps), or null. */
function prop(props: FlightObject, key: string): FlightNode {
  return props[key] ?? null;
}

/** Read a nested string field off an object node (e.g. `viewTrackingSpecs.viewName`). */
function nestedString(node: FlightNode, outer: string, inner: string): string | null {
  if (!isObject(node)) return null;
  const child = node[outer];
  if (!isObject(child)) return null;
  const value = child[inner];
  return typeof value === "string" ? value : null;
}

const NAVIGATE_TO_URL = "proto.sdui.actions.core.NavigateToUrl";

/** A Flight element is the 4-tuple `["$", tag, key, props]` with object props. */
function isElement(node: FlightNode): node is FlightElement {
  return (
    Array.isArray(node) &&
    node.length >= 4 &&
    node[0] === "$" &&
    typeof node[3] === "object" &&
    node[3] !== null &&
    !Array.isArray(node[3])
  );
}

function isObject(node: FlightNode | undefined): node is FlightObject {
  return typeof node === "object" && node !== null && !Array.isArray(node);
}

/**
 * Parse every component-tree row out of a Flight stream. The stream is
 * newline-delimited `<id>:<payload>` rows; a row holding UI is one whose
 * payload is a JSON array (an element tuple). `I[...]` import rows, string
 * rows, and non-JSON chunks are skipped.
 *
 * Crucially this returns ALL such rows, not just the first. The cards aren't
 * always in the first array row: a search-results *fragment* puts them in one
 * row, but a full SRP *page* load splits the tree across many rows (the app
 * shell comes first; the results render into a later row). Searching every row
 * handles both without caring which one holds the cards.
 */
function parseRows(body: string): FlightNode[] {
  const trees: FlightNode[] = [];
  for (const line of body.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const payload = line.slice(colon + 1);
    if (!payload.startsWith("[")) continue; // skip `I[...]` imports, strings, etc.
    try {
      trees.push(JSON.parse(payload) as FlightNode);
    } catch {
      // Not a complete JSON row (e.g. a truncated/streamed chunk) — skip it.
    }
  }
  return trees;
}

/** Collect every card: an element whose `viewTrackingSpecs.viewName` matches. */
function findCards(root: FlightNode, viewName: string): FlightElement[] {
  const cards: FlightElement[] = [];
  const visit = (node: FlightNode | undefined): void => {
    if (node === undefined) return;
    if (isElement(node)) {
      if (nestedString(node[3], "viewTrackingSpecs", "viewName") === viewName) cards.push(node);
      // Cards can nest (a result inside a cluster), so keep descending.
      for (const value of Object.values(node[3])) visit(value);
    } else if (Array.isArray(node)) {
      for (const child of node) visit(child);
    } else if (isObject(node)) {
      for (const value of Object.values(node)) visit(value);
    }
  };
  visit(root);
  return cards;
}

/** The first `NavigateToUrl` URL anywhere under a card (the profile link). */
function firstNavUrl(card: FlightElement): string | null {
  let found: string | null = null;
  const visit = (node: FlightNode | undefined): void => {
    if (found !== null || node === undefined) return;
    if (isObject(node)) {
      if (node["$type"] === NAVIGATE_TO_URL && typeof node["url"] === "string") {
        found = node["url"];
        return;
      }
      for (const value of Object.values(node)) visit(value);
    } else if (Array.isArray(node)) {
      for (const child of node) visit(child);
    }
  };
  visit(card);
  return found;
}

/**
 * The card's visible text as an ordered sequence, with consecutive duplicates
 * collapsed (an avatar's alt text repeats the member's name) and empty/
 * separator-only entries dropped. A bare string child is visible text; a
 * `$`-prefixed string is a Flight reference, not content.
 */
function visibleText(card: FlightElement): string[] {
  const out: string[] = [];
  const visit = (node: FlightNode | undefined): void => {
    if (node === undefined) return;
    if (isElement(node)) {
      visit(prop(node[3], "children"));
      const textProps = node[3]["textProps"];
      if (isObject(textProps)) visit(prop(textProps, "children"));
    } else if (Array.isArray(node)) {
      for (const child of node) visit(child);
    } else if (typeof node === "string" && node.trim() !== "" && !node.startsWith("$")) {
      if (out[out.length - 1] !== node) out.push(node);
    }
  };
  visit(card);
  return out;
}

/** Is this entry the connection-distance badge ("• 3rd+", "• 2nd")? */
function isDistanceBadge(text: string): boolean {
  return text.trim().startsWith("•");
}

/**
 * Map a card's text sequence onto a semantic role. The sequence (separators and
 * the distance badge already removed) is name, then headline, then location:
 *   - name     → first entry,
 *   - headline → first entry after the name that isn't the name repeated,
 *   - location → the entry after that headline.
 */
function textByRole(texts: string[], role: NonNullable<FlightTextField["role"]>): string | null {
  const content = texts.filter((t) => !isDistanceBadge(t));
  if (content.length === 0) return null;
  const name = content[0] ?? null;
  if (role === "name") return name;

  // Skip a leading repeat of the name (some cards echo it as the avatar label).
  const afterName = content.slice(1).filter((t) => t !== name);
  if (role === "headline") return afterName[0] ?? null;
  return afterName[1] ?? null; // location
}

/** Resolve one declared field for a card. */
function resolveField(
  field: FlightField,
  navUrl: string | null,
  texts: string[],
): string | null {
  if (field.from === "nav-url") {
    if (navUrl === null) return null;
    if (field.pattern === undefined) return navUrl;
    const match = navUrl.match(new RegExp(field.pattern));
    const captured = match?.[1] ?? match?.[0] ?? null;
    return captured === null ? null : safeDecodeUri(captured);
  }
  // from === "text"
  if (field.match !== undefined) {
    const re = new RegExp(field.match);
    // Match against the trimmed text: rendered badges carry leading/trailing
    // whitespace ("  • 3rd+ ") that shouldn't defeat an anchored pattern.
    return texts.map((t) => t.trim()).find((t) => re.test(t)) ?? null;
  }
  if (field.role !== undefined) return textByRole(texts, field.role);
  return texts[0] ?? null;
}

/** Decode a percent-encoded slug, falling back to the raw value if malformed. */
function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Run a Flight extraction: parse every row of the stream, find each card across
 * all of them, and project it onto the declared fields. Every field is present
 * (null when nothing matched). Returns an empty array when no card is found.
 *
 * Cards are deduped by their navigation URL: the same person shouldn't appear
 * twice if their card is referenced from more than one row.
 */
export function extractFlight(body: string, spec: MastroExtractFlight): ExtractedItem[] {
  const cards = parseRows(body).flatMap((tree) => findCards(tree, spec.item));

  const seen = new Set<string>();
  const items: ExtractedItem[] = [];
  for (const card of cards) {
    const navUrl = firstNavUrl(card);
    if (navUrl !== null) {
      if (seen.has(navUrl)) continue;
      seen.add(navUrl);
    }
    const texts = visibleText(card);
    const item: ExtractedItem = {};
    for (const [name, field] of Object.entries(spec.fields)) {
      item[name] = resolveField(field, navUrl, texts);
    }
    items.push(item);
  }
  return items;
}
