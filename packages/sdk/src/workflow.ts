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
    return workflow.result ? getPath({ steps }, workflow.result) : steps;
  }

  // -- step execution --------------------------------------------------------

  private async runStep(
    step: WorkflowStep,
    ctx: () => TemplateContext,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (step.foreach) {
      const items = asArray(renderTemplate(step.foreach, ctx(), { strict: false }));
      const results: unknown[] = [];
      for (const item of items) {
        const itemCtx = (): TemplateContext => ({ ...ctx(), item });
        results.push(await this.executeOnce(step, itemCtx));
      }
      return results;
    }
    return this.executeOnce(step, ctx);
  }

  /** One request (with optional poll loop) and its output extraction. */
  private async executeOnce(step: WorkflowStep, ctx: () => TemplateContext): Promise<unknown> {
    const op = this.deps.spec.byOperationId(step.operationId);
    if (!op) throw new WorkflowError(step.id, `unknown operationId "${step.operationId}"`);

    const attempts = step.poll?.attempts ?? 15;
    const delay = step.poll?.delay_ms ?? 1000;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const result = await this.sendRequest(step, op, ctx);

      if (!step.poll || this.deps.dryRun) return result;

      // Poll: store provisionally so `until` can reference this step's result.
      const probe: TemplateContext = { ...ctx(), steps: { ...(ctx().steps as object), [step.id]: result } };
      if (truthy(renderTemplate(step.poll.until, probe, { strict: false }))) return result;
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
      ? renderTemplateString(req.url, c, { strict: false })
      : this.deps.spec.baseUrl().replace(/\/$/, "") + op.path;

    const headers: Record<string, string> = req.no_auth ? {} : { ...this.deps.authHeaders() };
    if (req.headers) {
      for (const [k, v] of Object.entries(req.headers)) headers[k] = renderTemplateString(v, c, { strict: false });
    }

    const body = this.buildBody(req.body, headers, c);

    if (this.deps.dryRun) {
      this.planned.push({ step: step.id, method, url, headers: redactAuth(headers), body: previewBody(body) });
      // A placeholder keeps downstream templating from crashing on missing refs.
      return this.applyOutput(step, { dryRun: true });
    }

    const transport = req.transport === "direct" || req.no_auth ? this.direct : await this.deps.apiTransport();
    const res = await transport.send({ method, url, headers, body });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new WorkflowError(step.id, `HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = parseMaybeJson(text);
    return this.applyOutput(step, data);
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
        const path = renderTemplateString(`\${${file[1]!.trim()}}`, ctx, { strict: false });
        const bytes = readFileSync(path);
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      }
      return renderTemplateString(bodyTemplate, ctx, { strict: false });
    }

    const rendered = renderDeep(bodyTemplate, ctx, { strict: false });
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
    return value;
  }
}

// -- helpers ----------------------------------------------------------------

function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
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

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getPath(obj: unknown, path: string): unknown {
  const segments = path.split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
