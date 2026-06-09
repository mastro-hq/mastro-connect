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
 * direct (not through the browser proxy), with a binary file body.
 *
 * See docs/WORKFLOWS.md.
 */
import { readFileSync } from "node:fs";

import type {
  MastroWorkflow,
  OpenApiSpec,
  OperationView,
  WorkflowStep,
} from "@mastro/core";

import { renderDeep, renderTemplate, renderTemplateString, type TemplateContext } from "./template.ts";
import { FetchTransport, type Transport } from "./transport.ts";
import { getPath, parseMaybeJson, sleep } from "./util.ts";

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
  /** Transport for authenticated, possibly-challenged API calls (browser/curl). */
  apiTransport(): Promise<Transport>;
  /** When true, build the planned requests but don't send them. */
  dryRun?: boolean;
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
  /** Plain fetch for un-challenged, no-auth requests (e.g. presigned S3 PUT). */
  private readonly direct: Transport = new FetchTransport();

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

    if (this.deps.dryRun) return { dry_run: true, planned_requests: this.planned };
    // `result` names a step (e.g. "createListing") or a dotted path into one
    // ("createListing.slug"); resolve it against the steps map directly.
    return workflow.result ? getPath(steps, workflow.result) : steps;
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
      return this.applyOutput(step, raw);
    }

    const op = this.deps.spec.byOperationId(step.operationId);
    if (!op) throw new WorkflowError(step.id, `unknown operationId "${step.operationId}"`);

    const attempts = step.poll?.attempts ?? 15;
    const delay = step.poll?.delay_ms ?? 1000;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const raw = await this.sendRequest(step, op, ctx);

      if (!step.poll || this.deps.dryRun) return this.applyOutput(step, raw);

      // Poll: store the RAW response provisionally so `until` can reference any
      // field of this step's response (not just its extracted output).
      const probe: TemplateContext = { ...ctx(), steps: { ...(ctx().steps as object), [step.id]: raw } };
      if (truthy(renderTemplate(step.poll.until, probe, { strict: false }))) return this.applyOutput(step, raw);
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
      : this.deps.spec.baseUrl().replace(/\/$/, "") + op.path;

    const headers: Record<string, string> = req.no_auth ? {} : { ...this.deps.authHeaders() };
    if (req.headers) {
      for (const [k, v] of Object.entries(req.headers)) headers[k] = renderTemplateString(v, c, this.opts());
    }

    const body = this.buildBody(req.body, headers, c);

    if (this.deps.dryRun) {
      this.planned.push({ step: step.id, method, url, headers: redactAuth(headers), body: previewBody(body) });
      // A stub keeps downstream `${steps.<id>.<anything>}` refs resolvable (and
      // thus non-throwing under strict dry-run), since the real output is
      // unknown until the request actually runs.
      return stepStub();
    }

    const transport = req.transport === "direct" || req.no_auth ? this.direct : await this.deps.apiTransport();
    const res = await transport.send({ method, url, headers, body });
    const text = await res.text();
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

/** Mask sensitive headers in a dry-run preview. */
function redactAuth(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const secret = /^(authorization|cookie|x-user-id)$/i;
  for (const [k, v] of Object.entries(headers)) out[k] = secret.test(k) ? "••••" : v;
  return out;
}

/** Show a JSON body as parsed (for readability) or note a binary upload. */
function previewBody(body: string | Uint8Array<ArrayBuffer> | undefined): unknown {
  if (body === undefined) return undefined;
  if (typeof body !== "string") return `<binary ${body.byteLength} bytes>`;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function truthy(v: unknown): boolean {
  if (v == null || v === false || v === "" || v === "false") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}
