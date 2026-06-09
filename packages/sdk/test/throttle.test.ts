/**
 * Rate limiting: a burst up to the per-minute budget passes immediately, then
 * further requests are paced. We keep the assertion timing-tolerant (CI is
 * noisy) — the point is that the (N+1)th request within the window blocks.
 */
import { expect, test } from "bun:test";

import { TokenBucket, throttled, type Transport } from "../src/index.ts";

test("a fresh bucket lets a full burst through without blocking", async () => {
  const bucket = new TokenBucket(60);
  const start = Date.now();
  for (let i = 0; i < 60; i++) await bucket.take();
  // 60 tokens are available up front; the burst should be effectively instant.
  expect(Date.now() - start).toBeLessThan(200);
});

test("the token after the burst has to wait for a refill", async () => {
  // 60/min = one token per second. After draining, the next take waits ~1s.
  const bucket = new TokenBucket(60);
  for (let i = 0; i < 60; i++) await bucket.take();
  const start = Date.now();
  await bucket.take();
  expect(Date.now() - start).toBeGreaterThan(800);
});

test("invalid rates are rejected", () => {
  expect(() => new TokenBucket(0)).toThrow();
  expect(() => new TokenBucket(-5)).toThrow();
});

test("throttled() is a no-op passthrough when no limit is set", async () => {
  let sent = 0;
  const inner: Transport = {
    name: "mock",
    send: async () => {
      sent++;
      return { status: 200, headers: {}, text: async () => "" };
    },
  };
  const wrapped = throttled(inner, undefined);
  expect(wrapped).toBe(inner); // same object, no wrapper allocated
  await wrapped.send({ method: "GET", url: "https://x", headers: {} });
  expect(sent).toBe(1);
});

test("throttled() wraps and still delegates to the inner transport", async () => {
  const calls: string[] = [];
  const inner: Transport = {
    name: "mock",
    send: async (req) => {
      calls.push(req.url);
      return { status: 200, headers: {}, text: async () => "ok" };
    },
  };
  const wrapped = throttled(inner, 600); // generous limit → no real delay here
  expect(wrapped).not.toBe(inner);
  const res = await wrapped.send({ method: "GET", url: "https://x/1", headers: {} });
  expect(await res.text()).toBe("ok");
  expect(calls).toEqual(["https://x/1"]);
});
