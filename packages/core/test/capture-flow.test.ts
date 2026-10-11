/**
 * End-to-end capture loop without a real browser:
 *   broker.capture() starts a receiver → we simulate the extension fetching the
 *   bootstrap page and POSTing a capture → broker validates + persists.
 */
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { AuthBroker, FileStore, ProviderRegistry, Receiver } from "../src/index.ts";

const PROVIDERS_ROOT = join(import.meta.dir, "fixtures/providers");
const TMP = `/tmp/mastro-capture-test-${process.pid}`;

/** The tests play the extension themselves — never open the user's real browser. */
const noBrowser = (): void => {};

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

test("broker captures, validates, and persists a credential", async () => {
  const registry = new ProviderRegistry([PROVIDERS_ROOT]);
  const store = new FileStore(TMP);
  const broker = new AuthBroker(store, noBrowser);
  const provider = registry.load("testapp");

  // Simulate the extension as soon as the bootstrap URL is live.
  const capturePromise = broker.capture(provider, {
    onBootstrapUrl: async (url) => {
      const base = new URL(url).origin;
      const sessionId = url.split("/").pop()!;

      // 1. Bootstrap page renders with the embedded session payload.
      const page = await fetch(url).then((r) => r.text());
      expect(page).toContain("mastro-session");
      expect(page).toContain("TestApp");

      // 2. Extension posts the capture bundle (cookies → serialized fields).
      const res = await fetch(`${base}/api/browser-auth/captures/${sessionId}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: JSON.stringify({
          schema_version: "capture-bundle/v1",
          provider_id: "testapp",
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
  expect(store.get("testapp")?.fields.user_id).toBe("42");
});

test("broker rejects a capture missing api-profile required fields", async () => {
  const registry = new ProviderRegistry([PROVIDERS_ROOT]);
  const store = new FileStore(TMP);
  const broker = new AuthBroker(store, noBrowser);
  const provider = registry.load("testapp");

  const promise = broker.capture(provider, {
    onBootstrapUrl: async (url) => {
      const base = new URL(url).origin;
      const sessionId = url.split("/").pop()!;
      await fetch(`${base}/api/browser-auth/captures/${sessionId}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: JSON.stringify({
          schema_version: "capture-bundle/v1",
          provider_id: "testapp",
          captured_at: Math.floor(Date.now() / 1000),
          credentials: { access_token: "tok-123" }, // missing user_id
        }),
      });
    },
  });

  await expect(promise).rejects.toThrow(/missing required field/);
});

/** Drive a capture by simulating the extension's bundle POST. */
function simulateCapture(url: string, credentials: Record<string, unknown>): Promise<void> {
  const base = new URL(url).origin;
  const sessionId = url.split("/").pop()!;
  return fetch(`${base}/api/browser-auth/captures/${sessionId}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
    body: JSON.stringify({
      schema_version: "capture-bundle/v1",
      provider_id: "testapp",
      captured_at: Math.floor(Date.now() / 1000),
      credentials,
    }),
  }).then(() => undefined);
}

test("verify probe success is recorded on the credential", async () => {
  const registry = new ProviderRegistry([PROVIDERS_ROOT]);
  const store = new FileStore(TMP);
  const broker = new AuthBroker(store, noBrowser);
  const provider = registry.load("testapp"); // spec declares x-mastro-auth.verify

  let probed = false;
  const credential = await broker.capture(
    provider,
    { onBootstrapUrl: (url) => simulateCapture(url, { access_token: "t", user_id: "42" }) },
    {
      verify: async () => {
        probed = true;
        return { ok: true, checked_at: 123 };
      },
    },
  );

  expect(probed).toBe(true);
  expect(credential.validation).toEqual({ ok: true, checked_at: 123 });
  expect(store.get("testapp")?.validation?.ok).toBe(true);
});

test("a failed verify probe rejects login but persists the failure for status", async () => {
  const registry = new ProviderRegistry([PROVIDERS_ROOT]);
  const store = new FileStore(TMP);
  const broker = new AuthBroker(store, noBrowser);
  const provider = registry.load("testapp");

  const promise = broker.capture(
    provider,
    { onBootstrapUrl: (url) => simulateCapture(url, { access_token: "t", user_id: "42" }) },
    { verify: async () => ({ ok: false, checked_at: 1, detail: "HTTP 401" }) },
  );

  await expect(promise).rejects.toThrow(/test call failed.*HTTP 401/s);
  // The failed result is still stored, so `mastro status` can show it.
  expect(store.get("testapp")?.validation).toEqual({ ok: false, checked_at: 1, detail: "HTTP 401" });
});

test("receiver rejects a capture from a disallowed origin", async () => {
  const registry = new ProviderRegistry([PROVIDERS_ROOT]);
  const provider = registry.load("testapp");

  // Drive the receiver directly so we don't depend on the broker's long timeout.
  const receiver = new Receiver({
    providerId: provider.id,
    displayName: provider.manifest.display_name,
    launchUrl: provider.manifest.launch.url,
    manifest: provider.manifest,
  });
  const url = receiver.start();
  try {
    const base = new URL(url).origin;
    const res = await fetch(`${base}/api/browser-auth/captures/${receiver.sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example.com" },
      body: JSON.stringify({ provider_id: "testapp", credentials: {}, captured_at: 1 }),
    });
    expect(res.status).toBe(403);
    expect(receiver.getStatus().status).toBe("error");
  } finally {
    receiver.stop();
  }
});

test("receiver accepts a capture from the extension's chrome-extension:// origin", async () => {
  const registry = new ProviderRegistry([PROVIDERS_ROOT]);
  const provider = registry.load("testapp");
  const receiver = new Receiver({
    providerId: provider.id,
    displayName: provider.manifest.display_name,
    launchUrl: provider.manifest.launch.url,
    manifest: provider.manifest,
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
        provider_id: "testapp",
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
