/**
 * HTTP transport with optional browser impersonation.
 *
 * Some targets (Cloudflare Bot Management, Akamai) fingerprint the TLS/HTTP2
 * handshake (JA3/JA4). A normal runtime `fetch` uses the engine's TLS stack and
 * gets flagged as non-browser regardless of headers. When a provider's spec
 * sets `x-mastro-replay.impersonate_browser`, we route through a
 * `curl-impersonate` binary whose handshake matches a real Chrome.
 *
 * Strategy is pluggable behind the `Transport` interface so this stays testable
 * and so other impersonation backends can slot in later.
 */
export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /**
   * Raw body, already serialized. `Uint8Array<ArrayBuffer>` (not the looser
   * `ArrayBufferLike` default) so it satisfies the fetch `BodyInit` union
   * without a cast.
   */
  body?: string | Uint8Array<ArrayBuffer>;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text(): Promise<string>;
}

export interface Transport {
  readonly name: string;
  send(req: HttpRequest): Promise<HttpResponse>;
}

/** Default transport — the runtime's native fetch. Fine for non-fingerprinted APIs. */
export class FetchTransport implements Transport {
  readonly name = "fetch";

  async send(req: HttpRequest): Promise<HttpResponse> {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      text: () => res.text(),
    };
  }
}

/**
 * Browser-impersonating transport. Shells out to a curl-impersonate binary
 * (https://github.com/lwthiker/curl-impersonate) so the TLS fingerprint matches
 * Chrome. Falls back to the system `curl` if the impersonate binary is absent
 * (weaker fingerprint, but still HTTP/2 + real headers).
 */
export class CurlImpersonateTransport implements Transport {
  readonly name: string;

  constructor(private readonly binary: string) {
    this.name = `curl(${binary})`;
  }

  /** Find the best available curl-impersonate binary, or undefined. */
  static async detect(): Promise<CurlImpersonateTransport | undefined> {
    const candidates = [
      process.env.MASTRO_CURL_IMPERSONATE,
      "curl_chrome116",
      "curl-impersonate-chrome",
      "curl-impersonate",
    ].filter((bin): bin is string => bin !== undefined);

    for (const bin of candidates) {
      if (await which(bin)) return new CurlImpersonateTransport(bin);
    }
    // Last resort: plain curl (no JA3 spoofing, but a real curl handshake).
    if (await which("curl")) return new CurlImpersonateTransport("curl");
    return undefined;
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    const args = [
      "-sS",
      "-i", // include response headers so we can parse status + headers
      "-X",
      req.method,
    ];
    for (const [k, v] of Object.entries(req.headers)) args.push("-H", `${k}: ${v}`);
    if (req.body != null) {
      args.push("--data-binary", typeof req.body === "string" ? req.body : Buffer.from(req.body).toString());
    }
    args.push(req.url);

    const proc = Bun.spawn([this.binary, ...args], { stdout: "pipe", stderr: "pipe" });
    const raw = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`${this.binary} exited ${code}: ${err.slice(0, 300)}`);
    }
    return parseCurlResponse(raw);
  }
}

/** Choose a transport for a profile's replay rules. */
export async function selectTransport(impersonate: boolean): Promise<Transport> {
  if (impersonate) {
    const curl = await CurlImpersonateTransport.detect();
    if (curl) return curl;
    // No curl at all — fetch will likely 403 on Cloudflare, but surface that
    // honestly rather than silently failing. The CLI explains the install.
  }
  return new FetchTransport();
}

// -- helpers ----------------------------------------------------------------

async function which(bin: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["sh", "-c", `command -v ${bin}`], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** Parse `curl -i` output (headers + blank line + body), handling redirect chains. */
function parseCurlResponse(raw: string): HttpResponse {
  // curl -i emits one header block per response; keep the last (final) one.
  const blocks = raw.split(/\r?\n\r?\n/);
  let headerBlockIdx = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (/^HTTP\/\d/.test(blocks[i] ?? "")) headerBlockIdx = i;
  }
  const headerBlock = blocks[headerBlockIdx] ?? "";
  const body = blocks.slice(headerBlockIdx + 1).join("\n\n");

  const lines = headerBlock.split(/\r?\n/);
  const statusLine = lines[0] ?? "HTTP/1.1 0";
  const status = Number(statusLine.split(/\s+/)[1] ?? 0);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }

  return { status, headers, text: async () => body };
}
