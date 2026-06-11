/**
 * Connector replay tests against a mock origin. Proves the OpenAPI spec drives
 * request building (query/path/array params, x-mastro-auth headers incl.
 * ${uuid}, x-mastro-resolve taxonomy translation, x-mastro-result, recapture
 * mapping) — without touching the network or Cloudflare.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Server } from "bun";

import {
  OpenApiSpec,
  type CredentialStore,
  type OpenApiDocument,
  type PersistedCredential,
  type Provider,
} from "@mastro/core";

import { Connector, NotAuthenticatedError, RecaptureRequiredError } from "../src/index.ts";
import { FLIGHT_PEOPLE_STREAM } from "./fixtures/flight-people.ts";

// -- a tiny mock Depop-ish API ---------------------------------------------

let server: Server<unknown>;
let lastRequest: { url: string; headers: Headers; body?: string } | undefined;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.text() : undefined;
      lastRequest = { url: url.toString(), headers: req.headers, body };

      if (url.pathname === "/search/") {
        if (req.headers.get("authorization") !== "Bearer tok-123") {
          return new Response("nope", { status: 401 });
        }
        return Response.json({ objects: [{ id: 1, what: url.searchParams.get("what") }] });
      }
      if (url.pathname === "/sizeFilters/") {
        return Response.json([
          { children: [{ children: [{ composite_id: "54.4", name: "M" }, { composite_id: "54.5", name: "L" }] }] },
        ]);
      }
      // An SDUI-style endpoint: answers with a Flight stream, not JSON.
      if (url.pathname === "/sdui/search/") return new Response(FLIGHT_PEOPLE_STREAM);
      if (url.pathname === "/expired/") return new Response("gone", { status: 419 });
      // A taxonomy endpoint whose session has lapsed — used to prove a 401 during
      // x-mastro-resolve surfaces as RecaptureRequiredError, not a parsed body.
      if (url.pathname === "/recapFilters/") return new Response("nope", { status: 401 });
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => server.stop(true));

// Isolate the taxonomy cache (Connector reads MASTRO_HOME via mastroHome()).
const CACHE_ROOT = `/tmp/mastro-sdk-test-${process.pid}`;
process.env.MASTRO_HOME = CACHE_ROOT;
afterEach(() => rmSync(CACHE_ROOT, { recursive: true, force: true }));

// -- fixtures ---------------------------------------------------------------

function makeProvider(origin: string): Provider {
  const doc: OpenApiDocument = {
    openapi: "3.1.0",
    info: { title: "Mock", version: "1" },
    servers: [{ url: origin }],
    "x-mastro-auth": {
      required_fields: ["access_token"],
      headers: {
        authorization: "Bearer ${auth.access_token}",
        "x-user-id": "${auth.user_id}",
        "x-req-id": "${uuid}",
      },
    },
    "x-mastro-replay": { recapture_on: [401, 419] },
    paths: {
      "/search/": {
        get: {
          operationId: "search",
          "x-mastro-command": "search",
          "x-mastro-result": "objects",
          parameters: [
            { name: "what", in: "query", required: true, schema: { type: "string" } },
            {
              name: "sizes",
              in: "query",
              explode: true,
              schema: { type: "array", items: { type: "string" } },
              "x-mastro-resolve": {
                from: "sizeFilters",
                value_path: "[].children[].children[].composite_id",
                label_path: "[].children[].children[].name",
              },
            },
          ],
        },
      },
      "/sizeFilters/": {
        get: { operationId: "sizeFilters", "x-mastro-hidden": true },
      },
      "/expired/": {
        get: { operationId: "expired", "x-mastro-command": "expired" },
      },
      "/searchRecap/": {
        get: {
          operationId: "searchRecap",
          "x-mastro-command": "searchRecap",
          parameters: [
            {
              name: "sizes",
              in: "query",
              explode: true,
              schema: { type: "array", items: { type: "string" } },
              "x-mastro-resolve": {
                from: "recapFilters",
                value_path: "[].id",
                label_path: "[].name",
              },
            },
          ],
        },
      },
      "/recapFilters/": {
        get: { operationId: "recapFilters", "x-mastro-hidden": true },
      },
      // A server-driven-UI search: a fixed body envelope (only `keywords`
      // varies), an operation-specific header set, and a Flight-format response.
      "/sdui/search/": {
        post: {
          operationId: "sduiSearch",
          "x-mastro-command": "sdui-search",
          parameters: [{ name: "keywords", in: "query", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": {} } },
          "x-mastro-body": {
            envelope: "fixed",
            url: "/search?q=${args.keywords}",
            payload: { keywords: "${args.keywords}", origin: "HEADER" },
          },
          "x-mastro-headers": { accept: "*/*", "x-li-rsc-stream": "true" },
          "x-mastro-extract": {
            format: "flight",
            item: "people-search-result",
            fields: {
              name: { from: "text", role: "name" },
              headline: { from: "text", role: "headline" },
              url: { from: "nav-url" },
              publicId: { from: "nav-url", pattern: "/in/([^/?]+)" },
            },
          },
        },
      },
    },
  };
  const manifest = { provider_id: "mock", display_name: "Mock" } as Provider["manifest"];
  return { id: `mock-${process.pid}`, dir: "/tmp/mock", manifest, spec: new OpenApiSpec(doc) };
}

function storeWith(cred: PersistedCredential | undefined): CredentialStore {
  return { get: () => cred, set: () => {}, delete: () => false, list: () => (cred ? ["mock"] : []) };
}

const validCred: PersistedCredential = {
  provider_id: "mock",
  captured_at: 1,
  fields: { access_token: "tok-123", user_id: "42" },
};

// -- tests ------------------------------------------------------------------

test("builds request from OpenAPI op: auth headers, generated uuid, result path", async () => {
  const provider = makeProvider(server.url.origin);
  const connector = Connector.load(provider, storeWith(validCred));
  const op = connector.byCommand("search")!;

  const result = await connector.call(op, { what: "shirt" });

  expect(lastRequest?.headers.get("authorization")).toBe("Bearer tok-123");
  expect(lastRequest?.headers.get("x-user-id")).toBe("42");
  expect(lastRequest?.headers.get("x-req-id")).toMatch(/^[0-9a-f-]{36}$/); // a real uuid
  expect(result.result).toEqual([{ id: 1, what: "shirt" }]);
});

test("array query param explodes (sizes=a&sizes=b) and resolves labels to wire ids", async () => {
  const provider = makeProvider(server.url.origin);
  const connector = Connector.load(provider, storeWith(validCred));
  const op = connector.byCommand("search")!;

  // "M" is a label → resolves to composite_id 54.4; "54.5" passes through as a wire id.
  await connector.call(op, { what: "x", sizes: ["M", "54.5"] });

  const url = new URL(lastRequest!.url);
  expect(url.searchParams.getAll("sizes")).toEqual(["54.4", "54.5"]);
});

test("missing credential → NotAuthenticatedError", () => {
  const provider = makeProvider(server.url.origin);
  expect(() => Connector.load(provider, storeWith(undefined))).toThrow(NotAuthenticatedError);
});

test("recapture_on status → RecaptureRequiredError", async () => {
  const provider = makeProvider(server.url.origin);
  const connector = Connector.load(provider, storeWith(validCred));
  const op = connector.byCommand("expired")!;
  await expect(connector.call(op, {})).rejects.toThrow(RecaptureRequiredError);
});

test("a 401 while resolving a taxonomy → RecaptureRequiredError (not a parsed body)", async () => {
  const provider = makeProvider(server.url.origin);
  const connector = Connector.load(provider, storeWith(validCred));
  const op = connector.byCommand("searchRecap")!;
  // Resolving --sizes hits /recapFilters/, which 401s; that must propagate as a
  // recapture signal rather than being swallowed into an empty taxonomy.
  await expect(connector.call(op, { sizes: ["M"] })).rejects.toThrow(RecaptureRequiredError);
});

test("SDUI op: x-mastro-body templates the fixed envelope with the keyword", async () => {
  const provider = makeProvider(server.url.origin);
  const connector = Connector.load(provider, storeWith(validCred));
  const op = connector.byCommand("sdui-search")!;

  await connector.call(op, { keywords: "ada lovelace" });

  // The body is the fixed envelope with `keywords` interpolated everywhere it
  // appears — not a flat payload assembled from parameters.
  const sent = JSON.parse(lastRequest!.body!);
  expect(sent).toEqual({
    envelope: "fixed",
    url: "/search?q=ada lovelace",
    payload: { keywords: "ada lovelace", origin: "HEADER" },
  });
  // The keyword also rides as a query param (parameters still feed the URL).
  expect(new URL(lastRequest!.url).searchParams.get("keywords")).toBe("ada lovelace");
});

test("SDUI op: x-mastro-headers override the global auth accept header", async () => {
  const provider = makeProvider(server.url.origin);
  const connector = Connector.load(provider, storeWith(validCred));
  const op = connector.byCommand("sdui-search")!;

  await connector.call(op, { keywords: "x" });

  expect(lastRequest?.headers.get("x-li-rsc-stream")).toBe("true");
  expect(lastRequest?.headers.get("accept")).toBe("*/*");
  // Global auth headers still apply (they're not wiped by the override).
  expect(lastRequest?.headers.get("authorization")).toBe("Bearer tok-123");
});

test("SDUI op: a Flight response is extracted into people cards", async () => {
  const provider = makeProvider(server.url.origin);
  const connector = Connector.load(provider, storeWith(validCred));
  const op = connector.byCommand("sdui-search")!;

  const result = await connector.call(op, { keywords: "x" });

  expect(result.data).toEqual([
    {
      name: "Ada Lovelace",
      headline: "Mathematician at Analytical Engine Co.",
      url: "https://www.linkedin.com/in/ada-lovelace/",
      publicId: "ada-lovelace",
    },
    {
      name: "Grace Hopper",
      headline: "Rear Admiral | Compiler Pioneer",
      url: "https://www.linkedin.com/in/grace-hopper-7b3/",
      publicId: "grace-hopper-7b3",
    },
    {
      name: "Ali H.",
      headline: "منتج في الهندسة",
      url: "https://www.linkedin.com/in/%D8%B9%D9%84%D9%8A-a434b5115/en/",
      publicId: "علي-a434b5115",
    },
  ]);
});
