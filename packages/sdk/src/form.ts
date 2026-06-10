/**
 * x-mastro-form — replay an HTML <form> as an application/x-www-form-urlencoded
 * body.
 *
 * Some state changes (Amazon's Buy Now → place-order) are gated behind a
 * server-rendered form carrying a one-time CSRF token plus a pile of hidden
 * fields. Re-deriving that body by hand is brittle (30+ fields, dynamic
 * values, per-render tokens). Instead a workflow step points at the form in a
 * prior response and we serialize it exactly as a browser would, then override
 * the few fields that submission adds (the clicked button, a JS-set flag).
 *
 * "Exactly as a browser would" = the HTML form-submission algorithm's
 * constructed entry list: skip un-named controls and buttons (submit / reset /
 * button / image / file), include a checkbox/radio only when `checked`, take a
 * <select>'s selected option (or its first option as the browser default), and
 * a <textarea>'s text content. Built on the streaming HTMLRewriter so a
 * multi-megabyte checkout page never needs a DOM.
 */
import { decodeEntities } from "./util.ts";

/** One submitted control: name → value, in document order. */
export interface FormField {
  name: string;
  value: string;
}

const SKIP_TYPES = new Set(["submit", "reset", "button", "image", "file"]);

/**
 * Parse the form matched by `selector` (default: the first <form>) into its
 * submittable fields, in document order. Returns `undefined` when no such form
 * exists, so a caller can fail loudly instead of POSTing an empty body.
 *
 * Only the **first** matching form is read — `querySelector` / getElementById
 * semantics. This matters because pages can carry duplicate ids: an Amazon
 * detail page renders several `#addToCart` buy boxes (New, Used, …), and the
 * browser submits only the first; matching all of them would splice a
 * different offer's price/merchant/token into the body. Fields are captured
 * only while inside that first form's open→close window.
 */
export async function parseFormFields(
  html: string,
  selector = "form",
): Promise<FormField[] | undefined> {
  const fields: FormField[] = [];
  let sawForm = false;
  // True only between the first matching form's start and end tags; gates the
  // descendant handlers so later duplicate forms are ignored.
  let active = false;
  let closed = false;

  // <select> is stateful across its <option> children: remember the open
  // select's name and whether any option claimed `selected`, committing the
  // chosen value on the select's end tag (browser default = first option).
  interface SelectState {
    name: string;
    chosen: string | undefined;
    first: string | undefined;
  }
  let select: SelectState | undefined;

  // <textarea> value is its text content, captured between tags.
  let textarea: { name: string; buf: string } | undefined;

  const rewriter = new HTMLRewriter();

  rewriter.on(selector, {
    element(el) {
      if (closed || active) return; // already captured the first form
      sawForm = true;
      active = true;
      el.onEndTag(() => {
        active = false;
        closed = true;
      });
    },
  });

  rewriter.on(`${selector} input`, {
    element(el) {
      if (!active) return;
      const name = el.getAttribute("name");
      if (!name) return;
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (SKIP_TYPES.has(type)) return;
      if ((type === "checkbox" || type === "radio") && !el.hasAttribute("checked")) return;
      fields.push({ name, value: decodeEntities(el.getAttribute("value") ?? "") });
    },
  });

  rewriter.on(`${selector} select`, {
    element(el) {
      if (!active) return;
      const name = el.getAttribute("name");
      if (!name) return;
      select = { name, chosen: undefined, first: undefined };
      el.onEndTag(() => {
        if (!select) return;
        const value = select.chosen ?? select.first ?? "";
        fields.push({ name: select.name, value: decodeEntities(value) });
        select = undefined;
      });
    },
  });

  rewriter.on(`${selector} select option`, {
    element(el) {
      if (!active || !select) return;
      const value = el.getAttribute("value") ?? "";
      if (select.first === undefined) select.first = value;
      if (el.hasAttribute("selected")) select.chosen = value;
    },
  });

  rewriter.on(`${selector} textarea`, {
    element(el) {
      if (!active) return;
      const name = el.getAttribute("name");
      if (!name) return;
      textarea = { name, buf: "" };
      el.onEndTag(() => {
        if (!textarea) return;
        fields.push({ name: textarea.name, value: decodeEntities(textarea.buf) });
        textarea = undefined;
      });
    },
    text(chunk) {
      if (textarea) textarea.buf += chunk.text;
    },
  });

  await rewriter.transform(new Response(html)).text();

  return sawForm ? fields : undefined;
}

/**
 * Serialize fields as an application/x-www-form-urlencoded body, applying
 * `set` (override an existing field in place, or append a new one) and `unset`
 * (drop by name). `set` values are already-rendered strings.
 */
export function encodeForm(
  fields: FormField[],
  set: Record<string, string> = {},
  unset: string[] = [],
): string {
  const drop = new Set(unset);
  const overrides = new Map(Object.entries(set));
  const params = new URLSearchParams();

  for (const { name, value } of fields) {
    if (drop.has(name)) continue;
    if (overrides.has(name)) {
      params.append(name, overrides.get(name)!);
      overrides.delete(name); // applied in place; don't append again below
      continue;
    }
    params.append(name, value);
  }
  // Remaining overrides are genuinely new fields (e.g. the submit button name).
  for (const [name, value] of overrides) params.append(name, value);

  return params.toString();
}
