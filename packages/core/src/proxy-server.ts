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
 */
import { randomBytes } from "node:crypto";
import type { Server } from "bun";

export interface ProxyRequest {
  id: string;
  /** Origin whose authenticated tab should run the fetch, e.g. https://www.depop.com. */
  origin: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

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

  /** Submit a request and resolve when the extension returns its response. */
  send(request: Omit<ProxyRequest, "id">, timeoutMs: number): Promise<ProxyResponse> {
    const id = randomBytes(12).toString("base64url");
    const full: ProxyRequest = { ...request, id };

    return new Promise<ProxyResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
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
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    if (req.method === "GET" && pathname === "/proxy/poll") {
      this.extensionSeen = true;
      const next = await this.nextRequest(25_000);
      return next ? cors(json(next)) : cors(new Response(null, { status: 204 }));
    }

    if (req.method === "POST" && pathname.startsWith("/proxy/response/")) {
      const id = pathname.slice("/proxy/response/".length);
      const result = (await safeJson(req)) as ProxyResponse | null;
      this.deliver(id, result);
      return cors(json({ ok: true }));
    }

    return cors(new Response("not found", { status: 404 }));
  }

  // -- queue plumbing --------------------------------------------------------

  private enqueue(req: ProxyRequest): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(req);
    else this.queue.push(req);
  }

  /** Resolve with the next queued request, or null after `timeoutMs`. */
  private nextRequest(timeoutMs: number): Promise<ProxyRequest | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== onReq);
        resolve(null);
      }, timeoutMs);
      const onReq = (req: ProxyRequest | null) => {
        clearTimeout(timer);
        resolve(req);
      };
      this.waiters.push(onReq);
    });
  }

  private deliver(id: string, result: ProxyResponse | null): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (result) p.resolve(result);
    else p.reject(new Error("extension returned a malformed proxy response"));
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

function cors(res: Response): Response {
  res.headers.set("access-control-allow-origin", "*");
  res.headers.set("access-control-allow-methods", "POST, GET, OPTIONS");
  res.headers.set("access-control-allow-headers", "content-type");
  return res;
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
