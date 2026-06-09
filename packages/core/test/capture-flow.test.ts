/**
 * End-to-end capture loop without a real browser:
 *   broker.capture() starts a receiver → we simulate the extension fetching the
 *   bootstrap page and POSTing a capture → broker validates + persists.
 */
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { AuthBroker, FileStore, ProviderRegistry, Receiver } from "../src/index.ts";

const PROVIDERS_ROOT = join(import.meta.dir, "../../../providers");
const TMP = `/tmp/mastro-capture-test-${process.pid}`;

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

test("broker captures, validates, and persists a Depop credential", async () => {
  const registry = new ProviderRegistry([PROVIDERS_ROOT]);
  const store = new FileStore(TMP);
  const broker = new AuthBroker(store);
  const depop = registry.load("depop");

  // Simulate the extension as soon as the bootstrap URL is live.
  const capturePromise = broker.capture(depop, {
    onBootstrapUrl: async (url) => {
      const base = new URL(url).origin;
      const sessionId = url.split("/").pop()!;

      // 1. Bootstrap page renders with the embedded session payload.
      const page = await fetch(url).then((r) => r.text());
      expect(page).toContain("mastro-session");
      expect(page).toContain("Depop");

      // 2. Extension posts the capture bundle (cookies → serialized fields).
      const res = await fetch(`${base}/api/browser-auth/captures/${sessionId}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: JSON.stringify({
          schema_version: "capture-bundle/v1",
          provider_id: "depop",
          captured_at: Math.floor(Date.now() / 1000),
          credentials: { access_token: "tok-123", user_id: "42" },
          browser_context: { user_agent: "Mozilla/5.0 test", locale: "en-US" },
          metadata: { method: "extension", observations_used: ["cookies"] },
        }),
      });
      expect((await res.json()).ok).toBe(true);
    },
  });

  const credential = await capturePromise;
  expect(credential.fields.access_token).toBe("tok-123");
  expect(credential.fields.user_id).toBe("42");
  expect(store.get("depop")?.fields.user_id).toBe("42");
});

test("broker rejects a capture missing api-profile required fields", async () => {
  const registry = new ProviderRegistry([PROVIDERS_ROOT]);
  const store = new FileStore(TMP);
  const broker = new AuthBroker(store);
  const depop = registry.load("depop");

  const promise = broker.capture(depop, {
    onBootstrapUrl: async (url) => {
      const base = new URL(url).origin;
      const sessionId = url.split("/").pop()!;
      await fetch(`${base}/api/browser-auth/captures/${sessionId}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: JSON.stringify({
          schema_version: "capture-bundle/v1",
          provider_id: "depop",
          captured_at: Math.floor(Date.now() / 1000),
          credentials: { access_token: "tok-123" }, // missing user_id
        }),
      });
    },
  });

  await expect(promise).rejects.toThrow(/missing required field/);
});

test("receiver rejects a capture from a disallowed origin", async () => {
  const registry = new ProviderRegistry([PROVIDERS_ROOT]);
  const depop = registry.load("depop");

  // Drive the receiver directly so we don't depend on the broker's long timeout.
  const receiver = new Receiver({
    providerId: depop.id,
    displayName: depop.manifest.display_name,
    launchUrl: depop.manifest.launch.url,
    manifest: depop.manifest,
  });
  const url = receiver.start();
  try {
    const base = new URL(url).origin;
    const res = await fetch(`${base}/api/browser-auth/captures/${receiver.sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example.com" },
      body: JSON.stringify({ provider_id: "depop", credentials: {}, captured_at: 1 }),
    });
    expect(res.status).toBe(403);
    expect(receiver.getStatus().status).toBe("error");
  } finally {
    receiver.stop();
  }
});

test("receiver accepts a capture from the extension's chrome-extension:// origin", async () => {
  const registry = new ProviderRegistry([PROVIDERS_ROOT]);
  const depop = registry.load("depop");
  const receiver = new Receiver({
    providerId: depop.id,
    displayName: depop.manifest.display_name,
    launchUrl: depop.manifest.launch.url,
    manifest: depop.manifest,
  });
  const url = receiver.start();
  try {
    const base = new URL(url).origin;
    // This is exactly how the extension's service worker posts: its origin is
    // chrome-extension://<id>, not the loopback page.
    const res = await fetch(`${base}/api/browser-auth/captures/${receiver.sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "chrome-extension://deadbeef" },
      body: JSON.stringify({
        schema_version: "capture-bundle/v1",
        provider_id: "depop",
        captured_at: Math.floor(Date.now() / 1000),
        credentials: { access_token: "t", user_id: "1", cookie_header: "a=b" },
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  } finally {
    receiver.stop();
  }
});
