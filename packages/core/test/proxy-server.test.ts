/**
 * Proxy-server plumbing: a CLI request is queued, an extension-like poller picks
 * it up, posts a response, and the CLI's send() resolves with it.
 */
import { afterEach, expect, test } from "bun:test";

import { ProxyServer } from "../src/index.ts";

let server: ProxyServer | undefined;
afterEach(() => server?.stop());

// Use an ephemeral, non-default port so tests don't collide with a real run.
function startServer(): { server: ProxyServer; base: string } {
  const s = new ProxyServer(0);
  const base = s.start();
  server = s;
  return { server: s, base };
}

test("relays a request to a poller and resolves with its response", async () => {
  const { server, base } = startServer();

  // Act as the extension: poll, run the "fetch", post the response.
  const pollerDone = (async () => {
    const req = await fetch(`${base}/proxy/poll?v=2`).then((r) => r.json());
    expect(req.origin).toBe("https://example.com");
    expect(req.url).toContain("example.com/search");
    await fetch(`${base}/proxy/response/${req.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: 200, headers: { "x-test": "1" }, bodyText: '{"ok":true}' }),
    });
  })();

  const res = await server.send(
    {
      kind: "fetch",
      origin: "https://example.com",
      method: "GET",
      url: "https://example.com/search?q=x",
      headers: { authorization: "Bearer t" },
    },
    5000,
  );

  await pollerDone;
  expect(res.status).toBe(200);
  expect(res.headers["x-test"]).toBe("1");
  expect(res.bodyText).toBe('{"ok":true}');
});

test("send() rejects on timeout when no extension polls", async () => {
  const { server } = startServer();
  await expect(
    server.send(
      { kind: "fetch", origin: "https://example.com", method: "GET", url: "https://example.com/", headers: {} },
      300,
    ),
  ).rejects.toThrow(/timed out waiting for the extension/);
});

test("a request submitted while a poll is open is delivered to that poll", async () => {
  const { server: s, base } = startServer();
  const pollPromise = fetch(`${base}/proxy/poll?v=2`);
  await new Promise((r) => setTimeout(r, 50)); // let the poll register

  // Swallow the eventual rejection when afterEach stops the server (no response
  // is ever posted for this request — we only assert it reached the poll).
  s.send(
    { kind: "fetch", origin: "https://x.com", method: "GET", url: "https://x.com/", headers: {} },
    2000,
  ).catch(() => {});

  const req = await pollPromise.then((r) => r.json());
  expect(req.origin).toBe("https://x.com");
});

test("relays a handoff job (kind, url, local_storage) to the poller", async () => {
  const { server, base } = startServer();

  const pollerDone = (async () => {
    const job = await fetch(`${base}/proxy/poll?v=2`).then((r) => r.json());
    expect(job.kind).toBe("handoff");
    expect(job.origin).toBe("https://app.example.com");
    expect(job.local_storage).toEqual({ cartKey: "k-1" });
    await fetch(`${base}/proxy/response/${job.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: 200, headers: {}, bodyText: '{"ok":true}' }),
    });
  })();

  const res = await server.send(
    {
      kind: "handoff",
      origin: "https://app.example.com",
      url: "https://app.example.com/cart",
      local_storage: { cartKey: "k-1" },
    },
    5000,
  );
  await pollerDone;
  expect(res.status).toBe(200);
});

test("an extension too old for the protocol (no allowlist, no handoff) gets no jobs", async () => {
  const { server, base } = startServer();
  const outcome = settle(
    server.send(
      { kind: "handoff", origin: "https://app.example.com", url: "https://app.example.com/cart", local_storage: {} },
      5000,
    ),
  );
  // A pre-handoff extension polls without ?v=.
  const poll = await fetch(`${base}/proxy/poll`);
  expect(poll.status).toBe(204);
  expect(await outcome).toMatch(/extension is out of date/);
});

/** A send's outcome as text — its rejection message, or "resolved" — handled from the start. */
function settle(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => "resolved",
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
}

const FETCH_JOB = {
  kind: "fetch",
  origin: "https://example.com",
  method: "GET",
  url: "https://example.com/",
  headers: { authorization: "Bearer secret" },
} as const;

test("a web page can't poll: a non-extension Origin is refused, and no CORS headers are served", async () => {
  const { server, base } = startServer();
  server.send(FETCH_JOB, 2000).catch(() => {});
  const res = await fetch(`${base}/proxy/poll`, { headers: { origin: "https://evil.example" } });
  expect(res.status).toBe(403);
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
});

test("requests a browser marks as cross-site are refused", async () => {
  const { base } = startServer();
  const res = await fetch(`${base}/proxy/poll`, { headers: { "sec-fetch-site": "cross-site" } });
  expect(res.status).toBe(403);
});

test("a rebinding Host header is refused", async () => {
  const { base } = startServer();
  const res = await fetch(`${base}/proxy/poll`, { headers: { host: "evil.example" } });
  expect(res.status).toBe(403);
});

test("a malformed posted response fails the job instead of resolving it", async () => {
  const { server, base } = startServer();
  const outcome = settle(server.send(FETCH_JOB, 5000));
  const job = await fetch(`${base}/proxy/poll?v=2`).then((r) => r.json());
  await fetch(`${base}/proxy/response/${job.id}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "chrome-extension://abc" },
    body: "{}",
  });
  expect(await outcome).toMatch(/malformed/);
});

test("a timed-out job is not handed to a later poll", async () => {
  const { server, base } = startServer();
  await expect(server.send(FETCH_JOB, 100)).rejects.toThrow(/timed out/);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const poll = await fetch(`${base}/proxy/poll`, { signal: controller.signal }).catch(() => null);
  expect(poll === null || poll.status === 204).toBe(true);
});
