/**
 * Browser-proxy server — lets the CLI run an HTTP request inside an
 * authenticated browser tab (via the extension), to get past Cloudflare-style
 * managed challenges that TLS impersonation can't solve.
 *
 * It's a small loopback broker between two parties:
 *   - the CLI submits a request and waits for its response;
 *   - the extension long-polls for pending requests, runs them in a real tab,
 *     and posts the responses back.
 *
 * See docs/BROWSER-PROXY.md. Loopback-only, in-memory, short-lived.
 *
 * Only the extension may talk to it. A web page in the user's browser can
 * reach 127.0.0.1 too, so every request is checked: the Host must be this
 * loopback port (no DNS rebinding), a browser-set Origin must be an extension,
 * and Sec-Fetch-Site must not say a web page sent it. No CORS headers are
 * served — the extension's host permission doesn't need them, and a page
 * mustn't be able to read a job (it carries session headers).
 */
import { randomBytes } from "node:crypto";
import type { Server } from "bun";

/** A job for the extension, discriminated by `kind`. */
export type ProxyRequest = ProxyFetchRequest | ProxyHandoffRequest;

/** Run an HTTP request inside an authenticated tab and relay the response. */
export interface ProxyFetchRequest {
  kind: "fetch";
  id: string;
  /** Origin whose authenticated tab should run the fetch, e.g. https://www.depop.com. */
  origin: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Hand a staged flow back to the user: write localStorage on `origin` (in an
 * existing tab there, or a new one), then navigate that tab to `url` and bring
 * it to the front. The response is a bare acknowledgement.
 */
export interface ProxyHandoffRequest {
  kind: "handoff";
  id: string;
  /** Origin whose tab receives the storage writes — `url`'s origin. */
  origin: string;
  url: string;
  local_storage: Record<string, string>;
}

/** A job as submitted by the CLI — the server assigns the `id`. */
export type ProxyJob = Omit<ProxyFetchRequest, "id"> | Omit<ProxyHandoffRequest, "id">;

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

interface Pending {
  request: ProxyRequest;
  resolve: (res: ProxyResponse) => void;
  reject: (err: Error) => void;
}

/**
 * Fixed loopback port so the extension always knows where to poll (a random
 * port would change every run). Override with MASTRO_PROXY_PORT.
 */
export const DEFAULT_PROXY_PORT = 7878;

/**
 * The job protocol version the extension reports on each poll (`?v=`). Version
 * 2 added `kind: "handoff"` and the extension's origin allowlist; an older
 * extension would run a handoff as a plain fetch and enforces no allowlist, so
 * it gets no jobs at all.
 */
export const PROTOCOL_VERSION = 2;

export class ProxyServer {
  private server?: Server<unknown>;
  private readonly queue: ProxyRequest[] = [];
  private readonly pending = new Map<string, Pending>();
  /** Extension long-polls waiting for work; resolved when a request arrives. */
  private waiters: ((req: ProxyRequest | null) => void)[] = [];

  constructor(private readonly port: number = proxyPort()) {}

  /** Start the loopback server and return its base URL. */
  start(): string {
    try {
      this.server = Bun.serve({
        hostname: "127.0.0.1",
        port: this.port,
        // Long-poll can sit open; give it headroom over the default.
        idleTimeout: 60,
        fetch: (req) => this.handle(req),
      });
    } catch (err) {
      throw new Error(
        `could not bind the browser-proxy port ${this.port}. ` +
          `Another mastro command may be running, or set MASTRO_PROXY_PORT.\n${
            err instanceof Error ? err.message : String(err)
          }`,
      );
    }
    return this.baseUrl();
  }

  baseUrl(): string {
    if (!this.server) throw new Error("proxy server not started");
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    for (const p of this.pending.values()) p.reject(new Error("proxy server stopped"));
    this.pending.clear();
    for (const w of this.waiters) w(null);
    this.waiters = [];
    this.server?.stop(true);
    this.server = undefined;
  }

  /** True once at least one extension poll has been seen (it's connected). */
  private extensionSeen = false;
  isExtensionConnected(): boolean {
    return this.extensionSeen;
  }

  /** Submit a job and resolve when the extension returns its response. */
  send(job: ProxyJob, timeoutMs: number): Promise<ProxyResponse> {
    const id = randomBytes(12).toString("base64url");
    const full: ProxyRequest = { ...job, id };

    return new Promise<ProxyResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Never hand a stale job to a later poll.
        const queued = this.queue.indexOf(full);
        if (queued !== -1) this.queue.splice(queued, 1);
        reject(new Error("browser proxy timed out waiting for the extension"));
      }, timeoutMs);

      const wrappedResolve = (res: ProxyResponse) => {
        clearTimeout(timer);
        resolve(res);
      };
      const wrappedReject = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };

      this.pending.set(id, { request: full, resolve: wrappedResolve, reject: wrappedReject });
      this.enqueue(full);
    });
  }

  // -- routing ---------------------------------------------------------------

  private async handle(req: Request): Promise<Response> {
    if (!this.fromExtension(req)) return new Response("forbidden", { status: 403 });
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/proxy/poll") {
      this.extensionSeen = true;
      const version = Number(url.searchParams.get("v") ?? "1");
      const next = await this.nextRequest(25_000, req.signal);
      if (!next) return new Response(null, { status: 204 });
      if (req.signal.aborted) {
        // The poller hung up while we waited: put the job back for the next one.
        this.queue.unshift(next);
        return new Response(null, { status: 204 });
      }
      if (!(version >= PROTOCOL_VERSION)) {
        // An older extension has no origin allowlist and would run a handoff as a fetch.
        this.fail(next.id, "the mastro extension is out of date — run `mastro extension install`, then hit ↻ on it in chrome://extensions");
        return new Response(null, { status: 204 });
      }
      return json(next);
    }

    if (req.method === "POST" && pathname.startsWith("/proxy/response/")) {
      const id = pathname.slice("/proxy/response/".length);
      this.deliver(id, parseProxyResponse(await safeJson(req)));
      return json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  }

  /** Whether a request came from the extension (or a non-browser client), not a web page. */
  private fromExtension(req: Request): boolean {
    const port = this.server?.port;
    const host = req.headers.get("host");
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
    const origin = req.headers.get("origin");
    if (origin !== null && !origin.startsWith("chrome-extension://")) return false;
    const site = req.headers.get("sec-fetch-site");
    return site === null || site === "none";
  }

  // -- queue plumbing --------------------------------------------------------

  private enqueue(req: ProxyRequest): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(req);
    else this.queue.push(req);
  }

  /**
   * Resolve with the next queued request, or null after `timeoutMs` — or as
   * soon as the polling connection goes away, so no job is handed to it.
   */
  private nextRequest(timeoutMs: number, signal: AbortSignal): Promise<ProxyRequest | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const done = (req: ProxyRequest | null) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(req);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      const onAbort = () => done(null);
      signal.addEventListener("abort", onAbort);
      this.waiters.push(done);
    });
  }

  private deliver(id: string, result: ProxyResponse | null): void {
    if (result) this.pending.get(id)?.resolve(result);
    else this.fail(id, "extension returned a malformed proxy response");
    this.pending.delete(id);
  }

  private fail(id: string, message: string): void {
    this.pending.get(id)?.reject(new Error(message));
    this.pending.delete(id);
  }
}

// -- helpers ----------------------------------------------------------------

function proxyPort(): number {
  const env = process.env.MASTRO_PROXY_PORT;
  const parsed = env ? Number(env) : NaN;
  return Number.isInteger(parsed) ? parsed : DEFAULT_PROXY_PORT;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A posted response, if it has the right shape: numeric status, string headers, string body. */
function parseProxyResponse(value: unknown): ProxyResponse | null {
  if (value === null || typeof value !== "object") return null;
  const { status, headers, bodyText } = value as Partial<Record<keyof ProxyResponse, unknown>>;
  if (typeof status !== "number" || typeof bodyText !== "string") return null;
  if (headers === null || typeof headers !== "object") return null;
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (typeof v === "string") clean[k] = v;
  return { status, headers: clean, bodyText };
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
