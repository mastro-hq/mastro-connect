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
    const req = await fetch(`${base}/proxy/poll`).then((r) => r.json());
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
      { origin: "https://example.com", method: "GET", url: "https://example.com/", headers: {} },
      300,
    ),
  ).rejects.toThrow(/timed out waiting for the extension/);
});

test("a request submitted while a poll is open is delivered to that poll", async () => {
  const { server: s, base } = startServer();
  const pollPromise = fetch(`${base}/proxy/poll`);
  await new Promise((r) => setTimeout(r, 50)); // let the poll register

  // Swallow the eventual rejection when afterEach stops the server (no response
  // is ever posted for this request — we only assert it reached the poll).
  s.send(
    { origin: "https://x.com", method: "GET", url: "https://x.com/", headers: {} },
    2000,
  ).catch(() => {});

  const req = await pollPromise.then((r) => r.json());
  expect(req.origin).toBe("https://x.com");
});
