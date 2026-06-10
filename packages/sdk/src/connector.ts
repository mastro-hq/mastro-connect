/**
 * Connector — replays a persisted credential against a provider's OpenAPI spec.
 *
 * Given a Provider (auth manifest + OpenAPI spec) and a CredentialStore, it:
 *   - loads + freshness-checks the credential,
 *   - builds a request from an OpenAPI operation + parsed CLI args
 *     (query/path/body params, OpenAPI array style/explode, enum constraints),
 *   - resolves any x-mastro-resolve parameters against their taxonomy endpoint,
 *   - applies x-mastro-auth (header/cookie templates, ${uuid}/${now} generators),
 *   - sends it through the right transport (impersonating if required),
 *   - maps response status to ok / retry / recapture.
 *
 * It knows nothing provider-specific — everything comes from the OpenAPI doc.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  isExpired,
  unixNow,
  type CredentialStore,
  type OpenApiSpec,
  type OperationView,
  type Parameter,
  type Provider,
  type ValidationResult,
} from "@mastro/core";

import { BrowserTransport } from "./browser-transport.ts";
import { JsonCache } from "./cache.ts";
import { extractItems } from "./extract.ts";
import { Resolver, type MetadataFetcher } from "./resolver.ts";
import { WorkflowRunner } from "./workflow.ts";
import { renderDeep, renderStringMap, renderTemplate, type TemplateContext } from "./template.ts";
import { selectTransport, type HttpResponse, type Transport } from "./transport.ts";
import { throttled } from "./throttle.ts";
import { getPath, metaRefreshUrl, parseMaybeJson, sleep } from "./util.ts";

export class NotAuthenticatedError extends Error {
  constructor(public readonly providerId: string, message?: string) {
    super(message ?? `not authenticated for "${providerId}". Run: mastro login ${providerId}`);
    this.name = "NotAuthenticatedError";
  }
}

export class RecaptureRequiredError extends Error {
  constructor(public readonly providerId: string, public readonly status: number) {
    super(
      `${providerId} rejected the request (HTTP ${status}). Your session likely expired.\n` +
        `Run: mastro login ${providerId}`,
    );
    this.name = "RecaptureRequiredError";
  }
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly bodySnippet: string) {
    super(`API returned HTTP ${status}: ${bodySnippet.slice(0, 300)}`);
    this.name = "ApiError";
  }
}

export interface CallResult {
  status: number;
  /** Parsed JSON if the body was JSON, else the raw text. */
  data: unknown;
  /** The slice of `data` at the operation's x-mastro-result path, if set. */
  result: unknown;
}

export class Connector {
  private transport?: Transport;
  /** The unwrapped base transport (the throttle wrapper hides it) — kept so
   * `close()` can release a BrowserTransport's proxy server. */
  private baseTransport?: Transport;
  private readonly resolver: Resolver;

  private constructor(
    private readonly provider: Provider,
    private readonly spec: OpenApiSpec,
    private readonly credential: { fields: Record<string, unknown> },
  ) {
    this.resolver = new Resolver(
      new JsonCache(provider.id),
      (operationId) => this.fetchMetadata(operationId),
      (relPath) => JSON.parse(readFileSync(join(provider.dir, relPath), "utf8")),
    );
  }

  /** Build a connector, loading + checking the credential up front. */
  static load(provider: Provider, store: CredentialStore): Connector {
    const credential = store.get(provider.id);
    if (!credential) throw new NotAuthenticatedError(provider.id);
    if (isExpired(credential)) {
      throw new NotAuthenticatedError(
        provider.id,
        `session for "${provider.id}" expired. Run: mastro login ${provider.id}`,
      );
    }
    return Connector.forCredential(provider, credential);
  }

  /**
   * Build a connector against an explicit credential, bypassing the store. Used
   * to verify a freshly-captured credential before it's persisted.
   */
  static forCredential(provider: Provider, credential: { fields: Record<string, unknown> }): Connector {
    if (!provider.spec) {
      throw new Error(`provider "${provider.id}" has no OpenAPI spec; nothing to call`);
    }
    return new Connector(provider, provider.spec, credential);
  }

  /** Operations exposed as CLI subcommands. */
  commands(): OperationView[] {
    return this.spec.commands();
  }

  byCommand(command: string): OperationView | undefined {
    return this.spec.byCommand(command);
  }

  /**
   * Probe the live session by calling the spec's `x-mastro-auth.verify`
   * operation. Returns a structured result (never throws): `ok: true` on a 2xx,
   * `ok: false` with a reason otherwise. Used right after capture so a stored
   * credential's `validation` reflects whether it actually works.
   */
  async verify(): Promise<ValidationResult> {
    const verifyOp = this.spec.auth().verify;
    if (!verifyOp) return { ok: true, checked_at: unixNow(), detail: "no verify operation declared" };

    const op = this.spec.byOperationId(verifyOp.operationId);
    if (!op) {
      return {
        ok: false,
        checked_at: unixNow(),
        detail: `verify references unknown operation "${verifyOp.operationId}"`,
      };
    }

    // The verify probe runs right after capture, so for a via_browser connector
    // it races the just-started browser proxy: the extension may not have picked
    // up the loopback server yet, and the first in-tab fetch can land before the
    // logged-in tab is ready (manifesting as a transient auth failure). Retry a
    // couple of times with a short backoff before declaring the session dead, so
    // a cold-start race doesn't reject a perfectly good credential.
    let detail = "unknown error";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.call(op, {});
        return { ok: true, checked_at: unixNow() };
      } catch (err) {
        detail =
          err instanceof RecaptureRequiredError || err instanceof ApiError
            ? `HTTP ${err.status}`
            : err instanceof Error
              ? err.message
              : String(err);
      }
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    }
    return { ok: false, checked_at: unixNow(), detail };
  }

  /**
   * Run a multi-step workflow operation (x-mastro-workflow). With `dryRun`, the
   * runner builds and returns the planned requests/body without sending them.
   */
  async runWorkflow(
    op: OperationView,
    args: Record<string, unknown>,
    opts: { dryRun?: boolean } = {},
  ): Promise<unknown> {
    const resolved = await this.resolveWorkflowArgs(op, args);
    const runner = new WorkflowRunner({
      spec: this.spec,
      authHeaders: () => this.authHeaders(),
      baseContext: () => this.authContext(),
      apiTransport: () => this.getTransport(),
      dryRun: opts.dryRun ?? false,
    });
    return runner.run(op, resolved);
  }

  /**
   * Translate workflow args that carry x-mastro-resolve (label → wire value).
   * A `key_template` arg is *derived* from other args (e.g. variant_set from
   * department+type) even when the user didn't pass it.
   */
  private async resolveWorkflowArgs(
    op: OperationView,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const out = { ...args };
    for (const arg of op.operation["x-mastro-args"] ?? []) {
      const resolve = arg["x-mastro-resolve"];
      if (!resolve) continue;

      if (resolve.key_template) {
        // Derived: build the key from other args; skip if already supplied.
        if (out[arg.name] !== undefined) continue;
        const key = renderTemplate(resolve.key_template, { args: out }, { strict: false });
        if (key) out[arg.name] = this.resolver.lookupKeyed(resolve, String(key));
        continue;
      }

      const value = out[arg.name];
      if (value === undefined) continue;
      out[arg.name] = Array.isArray(value)
        ? await Promise.all(value.map((v) => this.resolver.resolveValue(resolve, String(v))))
        : await this.resolver.resolveValue(resolve, String(value));
    }
    return out;
  }

  /** Auth-binding headers (no operation-specific content-type). */
  private authHeaders(): Record<string, string> {
    const ctx = this.authContext();
    const auth = this.spec.auth();
    const headers: Record<string, string> = {};
    if (auth.headers) Object.assign(headers, renderStringMap(auth.headers, ctx));
    if (auth.cookies) {
      const cookie = Object.entries(renderStringMap(auth.cookies, ctx))
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
      if (cookie) headers["cookie"] = cookie;
    }
    const ua = this.spec.replay().user_agent;
    if (ua) headers["user-agent"] = String(renderStringMap({ ua }, ctx).ua);
    return headers;
  }

  /** Invoke an operation with parsed CLI args (flag name → value). */
  async call(op: OperationView, args: Record<string, unknown>): Promise<CallResult> {
    const url = await this.buildUrl(op, args);
    const headers = this.buildHeaders(op);
    const body = this.buildBody(op, args);

    const transport = await this.getTransport();
    const { status, text } = await this.request(transport, {
      method: op.method.toUpperCase(),
      url,
      headers,
      body,
    });
    this.checkStatus(status, text);

    // An HTML-only operation declares x-mastro-extract: the structured items
    // become the data (nobody wants the raw page back).
    const extract = op.operation["x-mastro-extract"];
    const data = extract ? await extractItems(text, extract) : parseMaybeJson(text);
    const resultPath = op.operation["x-mastro-result"];
    const result = resultPath ? getPath(data, resultPath) : data;
    return { status, data, result };
  }

  /**
   * Send a request and read its body, following an HTML meta-refresh
   * interstitial when the spec opts in (Akamai-style bot walls answer with a
   * stub page that refreshes to the same URL plus a one-time token).
   */
  private async request(
    transport: Transport,
    req: Parameters<Transport["send"]>[0],
  ): Promise<{ status: number; text: string }> {
    let res = await this.sendWithRetry(transport, req);
    let text = await res.text();

    if (this.spec.replay().follow_html_refresh) {
      for (let hop = 0; hop < 2; hop++) {
        const target = metaRefreshUrl(text);
        if (!target) break;
        const url = new URL(target, req.url).toString();
        res = await this.sendWithRetry(transport, { method: "GET", url, headers: req.headers });
        text = await res.text();
      }
    }
    return { status: res.status, text };
  }

  // -- request construction --------------------------------------------------

  private async buildUrl(op: OperationView, args: Record<string, unknown>): Promise<string> {
    let path = op.path;
    const query = new URLSearchParams();

    for (const param of op.parameters) {
      const raw = args[param.name] ?? this.defaultFor(param);
      if (raw === undefined) {
        // A path placeholder must always be filled; a missing query param is fine.
        if (param.in === "path") {
          throw new Error(`operation "${op.id}" is missing required path param "${param.name}"`);
        }
        continue;
      }
      const values = await this.resolveParamValues(param, raw);

      if (param.in === "path") {
        path = path.replace(`{${param.name}}`, encodeURIComponent(String(values[0] ?? "")));
      } else if (param.in === "query") {
        appendQuery(query, param, values);
      }
    }

    const base = this.spec.baseUrl().replace(/\/$/, "");
    const url = new URL(base + path);
    for (const [k, v] of query.entries()) url.searchParams.append(k, v);
    return url.toString();
  }

  /** A param's schema default, templated against the auth context (`${auth.x}`). */
  private defaultFor(param: Parameter): unknown {
    const def = param.schema?.default;
    if (typeof def === "string") return renderTemplate(def, this.authContext(), { strict: false });
    return def;
  }

  /** Resolve a parameter's value(s), translating labels→wire via x-mastro-resolve. */
  private async resolveParamValues(param: Parameter, raw: unknown): Promise<string[]> {
    const inputs = Array.isArray(raw) ? raw.map(String) : [String(raw)];
    const resolve = param["x-mastro-resolve"];
    if (!resolve) return inputs;
    return Promise.all(inputs.map((v) => this.resolver.resolveValue(resolve, v)));
  }

  private buildHeaders(op: OperationView): Record<string, string> {
    const headers: Record<string, string> = { accept: "*/*", ...this.authHeaders() };
    const reqBody = op.operation.requestBody;
    if (reqBody) headers["content-type"] = firstContentType(reqBody) ?? "application/json";
    return headers;
  }

  private buildBody(op: OperationView, args: Record<string, unknown>): string | undefined {
    const reqBody = op.operation.requestBody;
    if (!reqBody) return undefined;

    // Body params are the operation parameters declared `in: "body"`-style via
    // the request schema; we feed the matching args through.
    const ct = firstContentType(reqBody) ?? "application/json";
    const payload: Record<string, unknown> = {};
    for (const param of op.parameters) {
      if (args[param.name] !== undefined) payload[param.name] = args[param.name];
    }
    const rendered = renderDeep(payload, this.authContext()) as Record<string, unknown>;

    if (ct.includes("x-www-form-urlencoded")) {
      const usp = new URLSearchParams();
      for (const [k, v] of Object.entries(rendered)) usp.set(k, String(v));
      return usp.toString();
    }
    return JSON.stringify(rendered);
  }

  /** Template context for auth binding: captured fields + value generators. */
  private authContext(): TemplateContext {
    return {
      auth: this.credential.fields,
      uuid: () => randomUUID(),
      now: () => unixNow(),
    };
  }

  // -- metadata fetch (for x-mastro-resolve) --------------------------------

  /** Fetch a taxonomy/metadata operation's raw body, by operationId. */
  private async fetchMetadata(operationId: string): Promise<unknown> {
    const op = this.spec.byOperationId(operationId);
    if (!op) throw new Error(`x-mastro-resolve references unknown operation "${operationId}"`);
    const url = await this.buildUrl(op, {});
    const transport = await this.getTransport();
    const { status, text } = await this.request(transport, {
      method: op.method.toUpperCase(),
      url,
      headers: this.buildHeaders(op),
    });
    // Apply the same status mapping as a normal call, so a 401 mid-resolution
    // surfaces as an actionable RecaptureRequiredError instead of being parsed
    // as if it were a taxonomy body.
    this.checkStatus(status, text);
    return parseMaybeJson(text);
  }

  // -- transport + status handling ------------------------------------------

  private async getTransport(): Promise<Transport> {
    if (!this.transport) {
      const replay = this.spec.replay();
      this.baseTransport = replay.via_browser
        ? new BrowserTransport()
        : await selectTransport(replay.impersonate_browser ?? false);
      // Pace every replayed request to the provider's declared budget. One
      // bucket per connector so a workflow's foreach and the main call share it.
      this.transport = throttled(this.baseTransport, replay.rate_limit?.requests_per_minute);
    }
    return this.transport;
  }

  /** Release any transport resources (e.g. the browser-proxy server). */
  close(): void {
    if (this.baseTransport instanceof BrowserTransport) this.baseTransport.stop();
    this.transport = undefined;
    this.baseTransport = undefined;
  }

  private async sendWithRetry(
    transport: Transport,
    req: Parameters<Transport["send"]>[0],
  ): Promise<HttpResponse> {
    const retryOn = new Set(this.spec.replay().retry_on ?? []);
    let last: HttpResponse | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      last = await transport.send(req);
      if (!retryOn.has(last.status)) return last;
      await sleep(250 * (attempt + 1));
    }
    return last!;
  }

  private checkStatus(status: number, body: string): void {
    const recaptureOn = new Set(this.spec.replay().recapture_on ?? []);
    if (recaptureOn.has(status)) throw new RecaptureRequiredError(this.provider.id, status);
    if (status < 200 || status >= 300) throw new ApiError(status, body);
  }
}

// -- helpers ----------------------------------------------------------------

/** Append a query parameter honoring OpenAPI style/explode for arrays. */
function appendQuery(query: URLSearchParams, param: Parameter, values: string[]): void {
  const isArray = param.schema?.type === "array";
  if (!isArray) {
    if (values[0] !== undefined) query.append(param.name, values[0]);
    return;
  }
  const explode = param.explode ?? true; // form/explode is the query default
  if (explode) {
    for (const v of values) query.append(param.name, v);
  } else {
    const sep = param.style === "spaceDelimited" ? " " : param.style === "pipeDelimited" ? "|" : ",";
    query.append(param.name, values.join(sep));
  }
}

function firstContentType(reqBody: { content: Record<string, unknown> }): string | undefined {
  return Object.keys(reqBody.content)[0];
}
