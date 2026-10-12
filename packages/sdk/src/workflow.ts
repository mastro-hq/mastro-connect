/**
 * WorkflowRunner — executes an `x-mastro-workflow` (a multi-step flow declared
 * in the OpenAPI doc) for stateful operations like "upload pictures → poll →
 * create listing".
 *
 * Each step calls an operation, optionally per-item (`foreach`) or repeatedly
 * (`poll`), and stores its result under `steps.<id>`. Later steps reference
 * earlier ones via `${steps.<id>...}`, CLI flags via `${args.*}`, and (inside a
 * foreach) the current item via `${item}`. Steps can override the URL / body /
 * method / transport / auth — e.g. a presigned S3 PUT runs unauthenticated,
 * direct (not through the browser proxy), with a binary file body. A step can
 * `fail_when` its 2xx response carries an in-band error, and the workflow can
 * end with a browser `handoff` for a human to finish (e.g. pay).
 *
 * See docs/WORKFLOWS.md.
 */
import { readFileSync } from "node:fs";

import type {
  OpenApiSpec,
  OperationView,
  TransportKind,
  WorkflowFormReplay,
  WorkflowHandoff,
  WorkflowStep,
} from "@mastro/core";

import { encodeForm, parseFormFields } from "./form.ts";
import { renderDeep, renderTemplate, renderTemplateString, type TemplateContext } from "./template.ts";
import type { Transport } from "./transport.ts";
import { getPath, parseMaybeJson, sameOriginRefresh, sleep } from "./util.ts";

export class WorkflowError extends Error {
  constructor(public readonly step: string, message: string) {
    super(`workflow step "${step}": ${message}`);
    this.name = "WorkflowError";
  }
}

export interface WorkflowDeps {
  spec: OpenApiSpec;
  /** Builds auth headers for an operation (from the connector). */
  authHeaders(): Record<string, string>;
  /** Base template context (auth fields + ${uuid}/${now} generators). */
  baseContext(): TemplateContext;
  /**
   * The transport for one request: an explicit kind ("direct" plain fetch,
   * "browser" extension proxy), or `undefined` for the spec's default.
   */
  transport(kind: TransportKind | undefined): Promise<Transport>;
  /**
   * Hand the flow back to the user's browser (x-mastro-workflow.handoff):
   * write localStorage on `url`'s origin, then open `url`. Required only by
   * workflows that declare a handoff.
   */
  handoff?(url: string, localStorage: Record<string, string>): Promise<void>;
  /** When true, build the planned requests but don't send them. */
  dryRun?: boolean;
}

/** A rendered x-mastro-workflow.handoff (listed in a dry-run plan). */
export interface PlannedHandoff {
  url: string;
  local_storage: Record<string, string>;
}

/** A request the workflow would send (returned for each step under --dry-run). */
export interface PlannedRequest {
  step: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export class WorkflowRunner {
  /** Planned requests, collected under --dry-run. */
  private readonly planned: PlannedRequest[] = [];

  constructor(private readonly deps: WorkflowDeps) {}

  /**
   * Template strictness. Under --dry-run we render strictly so an authoring
   * mistake — a typo'd `${args.colour}` or a missing field — fails loudly at
   * plan time instead of silently producing an empty value and sending a broken
   * request later. Live execution stays lenient (network/session state is
   * legitimately partial mid-flow). `${steps.*}` refs are exempt even in
   * dry-run because step outputs are stubbed, not real (see `stepStub`).
   */
  private opts(): { strict?: boolean } {
    return { strict: this.deps.dryRun ?? false };
  }

  /** Run a workflow operation and return the configured result. */
  async run(op: OperationView, args: Record<string, unknown>): Promise<unknown> {
    const workflow = op.operation["x-mastro-workflow"];
    if (!workflow) throw new Error(`operation "${op.id}" has no x-mastro-workflow`);

    /** Accumulated per-step results, exposed as ${steps.<id>}. */
    const steps: Record<string, unknown> = {};
    const ctx = (): TemplateContext => ({ ...this.deps.baseContext(), args, steps });

    for (const step of workflow.steps) {
      steps[step.id] = await this.runStep(step, ctx, args);
    }

    const handoff = workflow.handoff ? this.renderHandoff(workflow.handoff, ctx()) : undefined;
    if (this.deps.dryRun) {
      return { dry_run: true, planned_requests: this.planned, ...(handoff ? { handoff } : {}) };
    }
    // `result` names a step (e.g. "createListing") or a dotted path into one
    // ("createListing.slug"); resolve it against the steps map directly.
    const result = workflow.result ? getPath(steps, workflow.result) : steps;
    if (handoff) {
      try {
        if (!this.deps.handoff) throw new Error("no browser is available");
        await this.deps.handoff(handoff.url, handoff.local_storage);
      } catch (err) {
        // The steps already ran (a cart exists): don't lose what they made, or a
        // rerun would make it twice. Say where to finish by hand.
        const why = err instanceof Error ? err.message : String(err);
        throw new WorkflowError(
          "handoff",
          `${why}. The steps before it already ran — finish at ${handoff.url}. Result: ${JSON.stringify(result).slice(0, 500)}`,
        );
      }
    }
    return result;
  }

  // -- step execution --------------------------------------------------------

  private async runStep(
    step: WorkflowStep,
    ctx: () => TemplateContext,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (step.foreach) {
      const items = asArray(renderTemplate(step.foreach, ctx(), this.opts()));
      const results: unknown[] = [];
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        // Bind the current element to `${item}`, its position to `${index}`
        // (so a parallel list can be paired by index — e.g. photos ↔ slots),
        // and, when `as` is set, to that alias too (as documented on the step).
        const itemCtx = (): TemplateContext => ({
          ...ctx(),
          item,
          index,
          ...(step.as ? { [step.as]: item } : {}),
        });
        results.push(await this.executeOnce(step, itemCtx));
      }
      return results;
    }
    return this.executeOnce(step, ctx);
  }

  /** One request (with optional poll loop) and its output extraction. */
  private async executeOnce(step: WorkflowStep, ctx: () => TemplateContext): Promise<unknown> {
    // A step with no operationId is a pure transform: it makes no HTTP call and
    // just shapes its `value` (templated) through `output` (path/extract/coerce).
    // Used to derive one step's data from another (e.g. picture ids from slot
    // URLs) without an extra round-trip.
    if (!step.operationId) {
      const raw = step.value !== undefined ? renderTemplate(step.value, ctx(), this.opts()) : ctx().item;
      this.checkFailure(step, raw, ctx);
      return this.applyOutput(step, raw);
    }

    const op = this.deps.spec.byOperationId(step.operationId);
    if (!op) throw new WorkflowError(step.id, `unknown operationId "${step.operationId}"`);

    const attempts = step.poll?.attempts ?? 15;
    const delay = step.poll?.delay_ms ?? 1000;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const raw = await this.sendRequest(step, op, ctx);

      if (!step.poll || this.deps.dryRun) {
        this.checkFailure(step, raw, ctx);
        return this.applyOutput(step, raw);
      }

      // Poll: store the RAW response provisionally so `until` can reference any
      // field of this step's response (not just its extracted output).
      if (truthy(renderTemplate(step.poll.until, withRaw(step, raw, ctx), { strict: false }))) {
        this.checkFailure(step, raw, ctx);
        return this.applyOutput(step, raw);
      }
      await sleep(delay);
    }
    throw new WorkflowError(step.id, `polling did not complete after ${attempts} attempts`);
  }

  private async sendRequest(
    step: WorkflowStep,
    op: OperationView,
    ctx: () => TemplateContext,
  ): Promise<unknown> {
    const req = step.request ?? {};
    const c = ctx();

    const method = (req.method ?? op.method).toUpperCase();
    const url = req.url
      ? renderTemplateString(req.url, c, this.opts())
      : this.deps.spec.baseUrlFor(op).replace(/\/$/, "") + op.path;

    // Unauthenticated when the step says so (presigned URL) or the operation
    // is public (`security: []`) — never leak the credential to either.
    const headers: Record<string, string> = req.no_auth || op.isPublic ? {} : { ...this.deps.authHeaders() };
    if (req.headers) {
      for (const [k, v] of Object.entries(req.headers)) headers[k] = renderTemplateString(v, c, this.opts());
    }

    const body = req.form
      ? await this.buildFormBody(step, req.form, headers, c)
      : this.buildBody(req.body, headers, c);

    if (this.deps.dryRun) {
      const secret = new Set((this.deps.spec.auth().redact ?? []).map((h) => h.toLowerCase()));
      this.planned.push({ step: step.id, method, url, headers: redactAuth(headers, secret), body: previewBody(body) });
      // A stub keeps downstream `${steps.<id>.<anything>}` refs resolvable (and
      // thus non-throwing under strict dry-run), since the real output is
      // unknown until the request actually runs.
      return stepStub();
    }

    // Step override, else `no_auth` implies a direct fetch (a presigned URL
    // must not go through the logged-in tab), else the operation's own
    // x-mastro-transport, else the spec default.
    const kind = req.transport ?? (req.no_auth ? "direct" : op.operation["x-mastro-transport"]);
    const transport = await this.deps.transport(kind);
    let res = await transport.send({ method, url, headers, body });
    let text = await res.text();

    // Follow an Akamai-style meta-refresh bot wall, same as a single call()
    // (see connector.request) — a workflow GET can hit the stub interstitial
    // too. GET, same headers, at most two hops.
    if (this.deps.spec.replay().follow_html_refresh) {
      for (let hop = 0; hop < 2; hop++) {
        const next = sameOriginRefresh(text, url);
        if (!next) break;
        res = await transport.send({ method: "GET", url: next, headers });
        text = await res.text();
      }
    }

    if (res.status < 200 || res.status >= 300) {
      if (process.env.MASTRO_DEBUG_STEPS) {
        console.error(`[mastro-debug] step "${step.id}" ERROR ${res.status} body:`, text.slice(0, 1500));
      }
      throw new WorkflowError(step.id, `HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = parseMaybeJson(text);
    if (process.env.MASTRO_DEBUG_STEPS) {
      console.error(`[mastro-debug] step "${step.id}" raw response:`, JSON.stringify(data).slice(0, 600));
    }
    // Return the RAW response; `output` extraction happens in executeOnce after
    // any poll loop, so `poll.until` can reference the full response body.
    return data;
  }

  /**
   * Build the request body. A body template that is exactly `${file:<expr>}`
   * loads the referenced file as bytes (for binary uploads). Otherwise the body
   * is deep-template-resolved JSON.
   */
  private buildBody(
    bodyTemplate: unknown,
    headers: Record<string, string>,
    ctx: TemplateContext,
  ): string | Uint8Array<ArrayBuffer> | undefined {
    if (bodyTemplate === undefined) return undefined;

    if (typeof bodyTemplate === "string") {
      const file = bodyTemplate.match(/^\$\{file:(.+)\}$/);
      if (file) {
        // Read the bytes even in dry-run: it's a cheap way to catch a missing
        // photo before anything is sent. The path ref stays lenient (the user
        // gives a literal filename, not a templated field that could be typo'd).
        const path = renderTemplateString(`\${${file[1]!.trim()}}`, ctx, { strict: false });
        const bytes = readFileSync(path);
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      }
      return renderTemplateString(bodyTemplate, ctx, this.opts());
    }

    const rendered = renderDeep(bodyTemplate, ctx, this.opts());
    if (!headers["content-type"]) headers["content-type"] = "application/json";
    return JSON.stringify(rendered);
  }

  /**
   * Build an application/x-www-form-urlencoded body by replaying a server-
   * rendered <form> from a prior step's HTML (x-mastro-form). Captures the
   * form's CSRF token and hidden fields verbatim, then applies the templated
   * `set`/`unset` overrides (the clicked button, a JS-set flag). Under dry-run
   * the HTML is a step stub, so there's no real form to parse — emit a
   * placeholder body instead of failing.
   */
  private async buildFormBody(
    step: WorkflowStep,
    form: WorkflowFormReplay,
    headers: Record<string, string>,
    ctx: TemplateContext,
  ): Promise<string> {
    headers["content-type"] ??= "application/x-www-form-urlencoded";

    const set: Record<string, string> = {};
    for (const [k, v] of Object.entries(form.set ?? {})) set[k] = renderTemplateString(v, ctx, this.opts());

    if (this.deps.dryRun) {
      // `${steps.*}` is a stub in dry-run; the real form fields are unknown.
      return encodeForm([{ name: "<form-fields>", value: "<from " + (form.selector ?? "form") + ">" }], set, form.unset);
    }

    const html = renderTemplateString(form.html, ctx, { strict: false });
    const fields = await parseFormFields(html, form.selector);
    if (!fields) {
      throw new WorkflowError(step.id, `x-mastro-form: no form matched "${form.selector ?? "form"}"`);
    }
    return encodeForm(fields, set, form.unset);
  }

  /**
   * Throw when any `fail_when` template resolves truthy against the step's raw
   * response — an in-band error on a 2xx (e.g. `{"Message":"Site unavailable"}`).
   * Skipped under dry-run, where the response is a stub.
   */
  private checkFailure(step: WorkflowStep, raw: unknown, ctx: () => TemplateContext): void {
    if (!step.fail_when || this.deps.dryRun) return;
    const probe = withRaw(step, raw, ctx);
    for (const condition of step.fail_when) {
      const value = renderTemplate(condition, probe, { strict: false });
      if (truthy(value)) {
        throw new WorkflowError(step.id, typeof value === "string" ? value : `failed: ${condition}`);
      }
    }
  }

  /** Render the handoff's URL and storage values against the final context. */
  private renderHandoff(handoff: WorkflowHandoff, ctx: TemplateContext): PlannedHandoff {
    const localStorage: Record<string, string> = {};
    for (const [k, v] of Object.entries(handoff.local_storage ?? {})) {
      localStorage[k] = renderTemplateString(v, ctx, this.opts());
    }
    return { url: renderTemplateString(handoff.url, ctx, this.opts()), local_storage: localStorage };
  }

  /** Extract this step's stored result per its `output` config. */
  private applyOutput(step: WorkflowStep, data: unknown): unknown {
    const out = step.output;
    if (!out) return data;

    let value: unknown = out.path ? getPath(data, out.path) : data;
    if (out.extract && typeof value === "string") {
      const m = value.match(new RegExp(out.extract));
      if (m) value = m[1] ?? m[0];
    }
    if (out.coerce === "number" && typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      if (!Number.isNaN(n)) value = n;
    }
    return value;
  }
}

// -- helpers ----------------------------------------------------------------

function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Marker value a dry-run step output collapses to in previews and JSON. */
const PENDING = "<pending>";

/**
 * A dry-run stand-in for a step's real (unknown) output. Any *string* property
 * access — `${steps.upload.url}`, `${steps.batch.result.ready}` — returns
 * another stub, so a downstream reference resolves to a non-undefined
 * placeholder and doesn't trip strict templating. Serialization and coercion
 * hooks (toJSON, Symbol.*, valueOf, toString) instead collapse to the PENDING
 * string, so `JSON.stringify` and template interpolation terminate cleanly
 * rather than recursing forever.
 */
function stepStub(): unknown {
  return new Proxy(
    { toJSON: () => PENDING },
    {
      get(_t, prop) {
        // Anything the runtime asks for by symbol, or the well-known coercion
        // methods, must yield a real primitive — not another stub.
        if (typeof prop === "symbol") return undefined;
        // CRITICAL: must NOT be thenable. `await stepStub()` (every dry-run step
        // result is awaited) would call `.then(resolve, reject)`; if `then`
        // returned another stub/function it would recurse forever. Keep `then`
        // out of the coercion group below so the stub stays a plain value.
        if (prop === "then") return undefined;
        if (prop === "toJSON" || prop === "toString" || prop === "valueOf") return () => PENDING;
        return stepStub();
      },
    },
  );
}

/**
 * Mask sensitive headers in a dry-run preview: the usual suspects plus any the
 * spec lists in `x-mastro-auth.redact` (lower-cased).
 */
export function redactAuth(headers: Record<string, string>, extra: ReadonlySet<string>): Record<string, string> {
  const out: Record<string, string> = {};
  const secret = /^(authorization|cookie|x-user-id)$/i;
  for (const [k, v] of Object.entries(headers)) out[k] = secret.test(k) || extra.has(k.toLowerCase()) ? "••••" : v;
  return out;
}

/** Show a JSON body as parsed (for readability) or note a binary upload. */
export function previewBody(body: string | Uint8Array<ArrayBuffer> | undefined): unknown {
  if (body === undefined) return undefined;
  if (typeof body !== "string") return `<binary ${body.byteLength} bytes>`;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** The context with this step's RAW response bound at `steps.<id>` (for poll/fail_when). */
function withRaw(step: WorkflowStep, raw: unknown, ctx: () => TemplateContext): TemplateContext {
  const c = ctx();
  return { ...c, steps: { ...(c.steps as object), [step.id]: raw } };
}

function truthy(v: unknown): boolean {
  if (v == null || v === false || v === "" || v === "false") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}
