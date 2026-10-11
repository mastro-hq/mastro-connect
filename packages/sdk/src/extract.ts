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
 *
 * Either way a field may instead be a **list field** (`each` + `fields`): one
 * flat object per `each` match inside the item (an order's line items). Its
 * entry fields follow the same streaming rules one level down — values attach
 * to the most recently opened entry.
 */
import type {
  ExtractField,
  ExtractListField,
  ExtractValueField,
  MastroExtract,
  MastroExtractHtml,
} from "@mastro/core";

import { extractFlight } from "./flight.ts";
import { decodeEntities } from "./util.ts";

/** One extracted scalar: a string, or null when nothing matched. */
export type ExtractedValue = string | null;
/** A flat extracted object — every list-field entry, and every Flight card. */
export type ExtractedRecord = Record<string, ExtractedValue>;
/** One extracted item: scalar fields, plus an array per list field. */
export type ExtractedItem = Record<string, ExtractedValue | ExtractedRecord[]>;

/** Open text capture for one field of one record, awaiting its end tag. */
interface TextCapture {
  record: ExtractedItem;
  buf: string;
  pattern: RegExp | undefined;
}

/** Collapse runs of whitespace the way rendered HTML would. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isListField(field: ExtractField): field is ExtractListField {
  return "each" in field;
}

/** `selector` scoped inside `scope` (document-scoped when there is none). */
function within(scope: string | undefined, selector: string): string {
  return scope === undefined ? selector : `${scope} ${selector}`;
}

const compiled = new WeakMap<ExtractValueField, RegExp>();

/** A field's `pattern` as a RegExp, compiled once per field. */
function compile(field: ExtractValueField): RegExp | undefined {
  if (field.pattern === undefined) return undefined;
  let re = compiled.get(field);
  if (!re) {
    re = new RegExp(field.pattern);
    compiled.set(field, re);
  }
  return re;
}

/** Apply a field's `pattern` (capture group 1, else the whole match). No match → null. */
function refine(value: string, pattern: RegExp | undefined): ExtractedValue {
  if (pattern === undefined) return value;
  const match = value.match(pattern);
  return match?.[1] ?? match?.[0] ?? null;
}

/**
 * A value field's initial value: its `attr` read off the item/entry element
 * itself when the field has no selector, otherwise null (filled by handlers).
 */
function readSelf(field: ExtractValueField, el: HTMLRewriterTypes.Element | undefined): ExtractedValue {
  const raw = el && !field.selector && field.attr ? el.getAttribute(field.attr) : null;
  return raw === null ? null : refine(decodeEntities(raw), compile(field));
}

/** A fresh item with every declared field present: null/self-attr for values, [] for lists. */
function seedItem(fields: Record<string, ExtractField>, el?: HTMLRewriterTypes.Element): ExtractedItem {
  const item: ExtractedItem = {};
  for (const [name, field] of Object.entries(fields)) {
    item[name] = isListField(field) ? [] : readSelf(field, el);
  }
  return item;
}

/** A fresh list entry with every declared field present. */
function seedEntry(
  fields: Record<string, ExtractValueField>,
  el: HTMLRewriterTypes.Element,
): ExtractedRecord {
  const entry: ExtractedRecord = {};
  for (const [name, field] of Object.entries(fields)) entry[name] = readSelf(field, el);
  return entry;
}

/**
 * Register handlers filling `fields` (value fields with a selector) on the
 * record `current()` returns — the most recently opened item or entry. First
 * match wins. Returns a flush for text captures whose end tag never fired.
 */
function bindValueFields(
  rewriter: HTMLRewriter,
  scope: string | undefined,
  fields: Record<string, ExtractValueField>,
  current: () => ExtractedItem | undefined,
): () => void {
  /** field name → capture in progress (only one per field at a time). */
  const captures = new Map<string, TextCapture>();

  for (const [name, field] of Object.entries(fields)) {
    if (!field.selector) continue;
    const scoped = within(scope, field.selector);
    const attr = field.attr;
    const pattern = compile(field);

    if (attr) {
      rewriter.on(scoped, {
        element(el) {
          const record = current();
          if (record && record[name] === null) {
            const value = el.getAttribute(attr);
            if (value !== null) record[name] = refine(decodeEntities(value), pattern);
          }
        },
      });
    } else {
      rewriter.on(scoped, {
        element(el) {
          const record = current();
          if (!record || record[name] !== null || captures.has(name)) return;
          const capture: TextCapture = { record, buf: "", pattern };
          captures.set(name, capture);
          el.onEndTag(() => {
            record[name] = refine(collapse(decodeEntities(capture.buf)), capture.pattern);
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

  return () => {
    for (const [name, capture] of captures) {
      if (capture.record[name] === null) {
        capture.record[name] = refine(collapse(decodeEntities(capture.buf)), capture.pattern);
      }
    }
  };
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
  const currentItem = (): ExtractedItem | undefined => items.at(-1);
  const rewriter = new HTMLRewriter();

  if (itemsSelector === undefined) {
    // One implicit item for the whole document; document-scoped field handlers
    // (registered below) fill it. Pre-seeding every field keeps first-match and
    // "already set?" checks behaving exactly as in array mode.
    items.push(seedItem(spec.fields));
  } else {
    rewriter.on(itemsSelector, {
      element(el) {
        items.push(seedItem(spec.fields, el));
      },
    });
  }

  const valueFields: Record<string, ExtractValueField> = {};
  const flushes: Array<() => void> = [];

  for (const [name, field] of Object.entries(spec.fields)) {
    if (!isListField(field)) {
      valueFields[name] = field;
      continue;
    }
    // Each `each` match opens a new entry on the current item; entry fields are
    // scoped under it and fill the latest entry.
    const entryScope = within(itemsSelector, field.each);
    const entries = (): ExtractedRecord[] | undefined => {
      const list = currentItem()?.[name];
      return Array.isArray(list) ? list : undefined;
    };
    rewriter.on(entryScope, {
      element(el) {
        entries()?.push(seedEntry(field.fields, el));
      },
    });
    flushes.push(bindValueFields(rewriter, entryScope, field.fields, () => entries()?.at(-1)));
  }
  flushes.push(bindValueFields(rewriter, itemsSelector, valueFields, currentItem));

  // Consuming the body is what drives the stream (and the handlers).
  await rewriter.transform(new Response(html)).text();

  // Flush captures whose end tag never fired (void/unclosed elements).
  for (const flush of flushes) flush();
  return itemsSelector === undefined ? items[0]! : items;
}
