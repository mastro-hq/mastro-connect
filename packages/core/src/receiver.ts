/**
 * Localhost receiver — the bridge between the broker and the Chrome extension.
 *
 * Lifecycle (one session per receiver instance):
 *   1. broker calls `start()` → Bun server bound to 127.0.0.1:<random port>.
 *   2. broker opens  GET /browser-auth/start/<sessionId>  in the browser.
 *   3. bootstrap page hands the session payload to the extension.
 *   4. extension posts the capture to POST /api/browser-auth/captures/<sessionId>.
 *   5. `waitForCapture()` resolves; broker validates + persists; `stop()`.
 *
 * Everything is in memory and short-lived. The extension may only post to the
 * session it was handed, and only from the manifest's allowed_postback_origin.
 */
import { randomBytes } from "node:crypto";
import type { Server } from "bun";

import { renderBootstrapPage } from "./bootstrap-page.ts";
import type { AuthManifest, CaptureBundle } from "./types.ts";

export type SessionStatus =
  | "created"
  | "connected"
  | "captured"
  | "expired"
  | "error";

export interface SessionPayload {
  sessionId: string;
  providerId: string;
  displayName: string;
  launchUrl: string;
  /** The full manifest — the extension interprets it generically. */
  manifest: AuthManifest;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class Receiver {
  private server?: Server<unknown>;
  private status: SessionStatus = "created";
  private statusMessage = "";
  private readonly captured = defer<CaptureBundle>();

  readonly sessionId = base64url(randomBytes(24));

  constructor(private readonly payload: Omit<SessionPayload, "sessionId">) {}

  /** Bind to a random loopback port and return the bootstrap URL. */
  start(): string {
    const session: SessionPayload = { ...this.payload, sessionId: this.sessionId };
    this.status = "created";

    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0, // OS-assigned
      fetch: (req) => this.handle(req, session),
    });

    return `${this.baseUrl()}/browser-auth/start/${this.sessionId}`;
  }

  baseUrl(): string {
    if (!this.server) throw new Error("receiver not started");
    return `http://127.0.0.1:${this.server.port}`;
  }

  /** Resolves with the capture bundle, or rejects on timeout/error. */
  waitForCapture(timeoutMs: number): Promise<CaptureBundle> {
    const timer = setTimeout(() => {
      this.status = "expired";
      this.captured.reject(new Error("auth session timed out before capture"));
    }, timeoutMs);
    return this.captured.promise.finally(() => clearTimeout(timer));
  }

  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
  }

  getStatus(): { status: SessionStatus; message: string } {
    return { status: this.status, message: this.statusMessage };
  }

  // -- routing --------------------------------------------------------------

  private async handle(req: Request, session: SessionPayload): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const id = this.sessionId;

    if (req.method === "GET" && pathname === `/browser-auth/start/${id}`) {
      return html(renderBootstrapPage(session));
    }

    if (req.method === "GET" && pathname === `/api/browser-auth/sessions/${id}`) {
      return json(this.getStatus());
    }

    if (req.method === "POST" && pathname === `/api/browser-auth/client-status/${id}`) {
      const body = (await safeJson(req)) as { status?: SessionStatus; message?: string };
      if (body.status) this.status = body.status;
      this.statusMessage = body.message ?? "";
      return json({ ok: true });
    }

    if (req.method === "POST" && pathname === `/api/browser-auth/captures/${id}`) {
      return this.handleCapture(req, session);
    }

    // CORS preflight for the extension's postback.
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    return new Response("not found", { status: 404 });
  }

  private async handleCapture(req: Request, session: SessionPayload): Promise<Response> {
    // The legitimate poster is our extension (a service-worker fetch, so its
    // origin is `chrome-extension://<id>`) or the loopback bootstrap page. Reject
    // anything else so a stray web page can't feed us a forged capture. A missing
    // origin is allowed (some service-worker fetches omit it).
    const origin = req.headers.get("origin") ?? "";
    const allowed = session.manifest.security.allowed_postback_origin;
    if (origin && !isAllowedPoster(origin, allowed)) {
      this.status = "error";
      this.statusMessage = `rejected capture from disallowed origin ${origin}`;
      return cors(json({ ok: false, error: "origin not allowed" }, 403));
    }

    const bundle = (await safeJson(req)) as CaptureBundle | null;
    if (!bundle || bundle.provider_id !== session.providerId) {
      return cors(json({ ok: false, error: "malformed capture" }, 400));
    }

    this.status = "captured";
    // Resolve after a macrotask so this ACK is flushed to the extension before
    // the broker's validate/persist chain runs and (possibly) stops the server.
    setTimeout(() => this.captured.resolve(bundle), 0);
    return cors(json({ ok: true }));
  }
}

// -- response helpers -------------------------------------------------------

/**
 * The capture may come from our extension's service worker
 * (`chrome-extension://<id>`) or from the loopback bootstrap page. Anything else
 * (a real web origin) is rejected. `allowed` is the manifest's
 * allowed_postback_origin (the loopback base).
 */
function isAllowedPoster(origin: string, allowed: string | undefined): boolean {
  if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) {
    return true;
  }
  return allowed ? origin.startsWith(allowed) : true;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function html(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The extension posts cross-origin from the SaaS tab; allow the loopback receiver. */
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
