/**
 * BrowserTransport — runs a request inside an authenticated browser tab via the
 * mastro extension, to get past Cloudflare-style managed challenges that TLS
 * impersonation can't solve.
 *
 * It stands up a loopback ProxyServer, hands the request to the extension (which
 * long-polls the server), and the extension executes `fetch()` in a logged-in
 * tab on the request's origin and posts the response back.
 *
 * See docs/BROWSER-PROXY.md.
 */
import { ProxyServer } from "@mastro/core";

import type { HttpRequest, HttpResponse, Transport } from "./transport.ts";

export class BrowserProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserProxyError";
  }
}

export class BrowserTransport implements Transport {
  readonly name = "browser";

  private server?: ProxyServer;

  constructor(private readonly timeoutMs = 45_000) {}

  /** The loopback URL the extension polls. Starts the server on first use. */
  private ensureServer(): ProxyServer {
    if (!this.server) {
      this.server = new ProxyServer();
      this.server.start();
    }
    return this.server;
  }

  /** Where the extension should poll. The CLI surfaces this to the user. */
  pollUrl(): string {
    return `${this.ensureServer().baseUrl()}/proxy/poll`;
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    const server = this.ensureServer();
    const origin = new URL(req.url).origin;

    const res = await server.send(
      {
        origin,
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: typeof req.body === "string" ? req.body : req.body ? Buffer.from(req.body).toString() : undefined,
      },
      this.timeoutMs,
    );

    return {
      status: res.status,
      headers: res.headers,
      text: async () => res.bodyText,
    };
  }

  stop(): void {
    this.server?.stop();
    this.server = undefined;
  }
}
