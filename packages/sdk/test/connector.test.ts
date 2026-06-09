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

// -- a tiny mock Depop-ish API ---------------------------------------------

let server: Server<unknown>;
let lastRequest: { url: string; headers: Headers } | undefined;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      lastRequest = { url: url.toString(), headers: req.headers };

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
      if (url.pathname === "/expired/") return new Response("gone", { status: 419 });
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
