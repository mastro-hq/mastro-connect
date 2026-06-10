/**
 * x-mastro-extract — structured objects out of an HTML response.
 *
 * Some sites have no JSON API at all: the data only exists server-rendered
 * (e.g. Amazon search results). An operation can declare `x-mastro-extract`
 * with an `items` selector (one match per result) and per-field selectors,
 * and the connector turns the HTML body into an array of flat objects.
 *
 * Built on Bun's streaming HTMLRewriter, so a multi-megabyte page never
 * needs a DOM. Streaming has one consequence worth knowing: field values are
 * attached to the most recently opened item, and the first match per item
 * wins. Field selectors therefore must not match nested elements within one
 * item (a `div div`-style selector would double-count its text).
 *
 * Two shapes, chosen by whether `spec.items` is set:
 *   - **array mode** (`items` present): one object per `items` match, field
 *     selectors scoped inside it. Returns an array (search results).
 *   - **single-object mode** (`items` omitted): the whole document is one
 *     item, field selectors are document-scoped. Returns one object (a product
 *     detail page). Every field needs a `selector` — there is no item element
 *     to read a bare `attr` off.
 */
import type { MastroExtract } from "@mastro/core";

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
 * Run the extraction over an HTML document. In array mode each `spec.items`
 * match becomes one object and the result is an array; in single-object mode
 * (no `items`) the whole document yields one object. Every declared field is
 * present (null when nothing matched).
 */
export function extractItems(html: string, spec: MastroExtract & { items: string }): Promise<ExtractedItem[]>;
export function extractItems(html: string, spec: MastroExtract): Promise<ExtractedItem[] | ExtractedItem>;
export async function extractItems(
  html: string,
  spec: MastroExtract,
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
