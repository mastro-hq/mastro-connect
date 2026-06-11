/**
 * x-mastro-extract — structured objects out of a non-JSON response.
 *
 * Some sites have no JSON API at all: the data only exists server-rendered.
 * Two response shapes are handled, picked by the spec's `format` discriminant:
 *
 *   - `"html"` (default, this file) — server-rendered HTML (e.g. Amazon search
 *     results), parsed with CSS selectors.
 *   - `"flight"` (see flight.ts) — a React Server Components stream, where the
 *     UI is a server-driven component tree rather than markup (LinkedIn search).
 *
 * Both produce an array of flat objects that replaces the body as the data.
 *
 * The HTML path is built on Bun's streaming HTMLRewriter, so a multi-megabyte
 * page never needs a DOM. Streaming has one consequence worth knowing: field
 * values are attached to the most recently opened item, and the first match per
 * item wins. Field selectors therefore must not match nested elements within
 * one item (a `div div`-style selector would double-count its text).
 *
 * Two HTML shapes, chosen by whether `spec.items` is set:
 *   - **array mode** (`items` present): one object per `items` match, field
 *     selectors scoped inside it. Returns an array (search results).
 *   - **single-object mode** (`items` omitted): the whole document is one
 *     item, field selectors are document-scoped. Returns one object (a product
 *     detail page). Every field needs a `selector` — there is no item element
 *     to read a bare `attr` off.
 */
import type { MastroExtract, MastroExtractHtml } from "@mastro/core";

import { extractFlight } from "./flight.ts";
import { decodeEntities } from "./util.ts";

export type ExtractedItem = Record<string, string | null>;

/** Open text capture for one field of one item, awaiting its end tag. */
interface TextCapture {
  item: ExtractedItem;
  buf: string;
}

/** Collapse runs of whitespace the way rendered HTML would. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Run an extraction over a response body, dispatching on `spec.format`:
 *   - `"flight"` → walk a React Server Components stream (always an array).
 *   - `"html"`/omitted → CSS extraction. In array mode (`items` set) each match
 *     becomes one object and the result is an array; in single-object mode (no
 *     `items`) the whole document yields one object.
 * Every declared field is present (null when nothing matched).
 */
export function extractItems(
  body: string,
  spec: MastroExtractHtml & { items: string },
): Promise<ExtractedItem[]>;
export function extractItems(body: string, spec: MastroExtract): Promise<ExtractedItem[] | ExtractedItem>;
export async function extractItems(
  body: string,
  spec: MastroExtract,
): Promise<ExtractedItem[] | ExtractedItem> {
  if (spec.format === "flight") return extractFlight(body, spec);
  return extractHtml(body, spec);
}

/** CSS extraction over an HTML document (the `format: "html"` path). */
async function extractHtml(
  html: string,
  spec: MastroExtractHtml,
): Promise<ExtractedItem[] | ExtractedItem> {
  const itemsSelector = spec.items;
  const items: ExtractedItem[] = [];
  /** field name → capture in progress (only one per field at a time). */
  const captures = new Map<string, TextCapture>();

  const rewriter = new HTMLRewriter();

  if (itemsSelector === undefined) {
    // One implicit item for the whole document; document-scoped field handlers
    // (registered below) fill it. Pre-seed every field to null so first-match
    // and "already set?" checks behave exactly as in array mode.
    const item: ExtractedItem = {};
    for (const name of Object.keys(spec.fields)) item[name] = null;
    items.push(item);
  } else {
    rewriter.on(itemsSelector, {
      element(el) {
        const item: ExtractedItem = {};
        for (const [name, field] of Object.entries(spec.fields)) {
          // A field without a selector reads an attribute off the item itself.
          const value = !field.selector && field.attr ? el.getAttribute(field.attr) : null;
          item[name] = value === null ? null : decodeEntities(value);
        }
        items.push(item);
      },
    });
  }

  for (const [name, field] of Object.entries(spec.fields)) {
    if (!field.selector) continue;
    const scoped = itemsSelector === undefined ? field.selector : `${itemsSelector} ${field.selector}`;
    const attr = field.attr;

    if (attr) {
      rewriter.on(scoped, {
        element(el) {
          const item = items.at(-1);
          if (item && item[name] === null) {
            const value = el.getAttribute(attr);
            if (value !== null) item[name] = decodeEntities(value);
          }
        },
      });
    } else {
      rewriter.on(scoped, {
        element(el) {
          const item = items.at(-1);
          if (!item || item[name] !== null || captures.has(name)) return;
          const capture: TextCapture = { item, buf: "" };
          captures.set(name, capture);
          el.onEndTag(() => {
            item[name] = collapse(decodeEntities(capture.buf));
            captures.delete(name);
          });
        },
        text(chunk) {
          const capture = captures.get(name);
          if (capture) capture.buf += chunk.text;
        },
      });
    }
  }

  // Consuming the body is what drives the stream (and the handlers).
  await rewriter.transform(new Response(html)).text();

  // Flush captures whose end tag never fired (void/unclosed elements).
  for (const [name, capture] of captures) {
    if (capture.item[name] === null) capture.item[name] = collapse(decodeEntities(capture.buf));
  }
  return itemsSelector === undefined ? items[0]! : items;
}
