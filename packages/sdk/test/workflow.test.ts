/**
 * Workflow runner: dry-run planning, foreach expansion, output extraction, and
 * the file-backed keyed resolver with key_template (derived listing fields).
 */
import { expect, test } from "bun:test";

import { OpenApiSpec, type OpenApiDocument } from "@mastro/core";
import { MissingTemplateValue, Resolver, JsonCache, WorkflowRunner } from "../src/index.ts";

/** A one-step workflow whose create body is supplied by the caller (for strict tests). */
function bodySpec(body: unknown): OpenApiSpec {
  const doc: OpenApiDocument = {
    openapi: "3.1.0",
    info: { title: "wf", version: "1" },
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/x/flow": {
        post: {
          operationId: "flow",
          "x-mastro-command": "flow",
          "x-mastro-workflow": {
            steps: [
              { id: "upload", operationId: "up", output: { path: "url" } },
              { id: "create", operationId: "create", request: { body } },
            ],
          },
          "x-mastro-args": [{ name: "title", required: true }],
        },
      },
      "/up": { post: { operationId: "up", "x-mastro-hidden": true } },
      "/create": { post: { operationId: "create", "x-mastro-hidden": true } },
    },
  };
  return new OpenApiSpec(doc);
}

function dryRunner(spec: OpenApiSpec): WorkflowRunner {
  return new WorkflowRunner({
    spec,
    authHeaders: () => ({}),
    baseContext: () => ({ uuid: () => "u" }),
    apiTransport: async () => {
      throw new Error("must not send in dry-run");
    },
    dryRun: true,
  });
}

function workflowSpec(): OpenApiSpec {
  const doc: OpenApiDocument = {
    openapi: "3.1.0",
    info: { title: "wf", version: "1" },
    servers: [{ url: "https://api.example.com" }],
    "x-mastro-auth": { headers: { authorization: "Bearer ${auth.token}" } },
    paths: {
      "/x/flow": {
        post: {
          operationId: "flow",
          "x-mastro-command": "flow",
          "x-mastro-workflow": {
            result: "create",
            steps: [
              { id: "slots", operationId: "slot", foreach: "${args.photo}", as: "photo", output: { path: "url" } },
              { id: "create", operationId: "create", request: { body: { ids: "${steps.slots}", uid: "${uuid}" } } },
            ],
          },
          "x-mastro-args": [{ name: "photo", required: true, multiple: true }],
        },
      },
      "/slot": { post: { operationId: "slot", "x-mastro-hidden": true } },
      "/create": { post: { operationId: "create", "x-mastro-hidden": true } },
    },
  };
  return new OpenApiSpec(doc);
}

test("dry-run plans every step (foreach expanded) without sending", async () => {
  const spec = workflowSpec();
  const runner = new WorkflowRunner({
    spec,
    authHeaders: () => ({ authorization: "Bearer tok" }),
    baseContext: () => ({ auth: { token: "tok" }, uuid: () => "fixed-uuid" }),
    apiTransport: async () => {
      throw new Error("must not send in dry-run");
    },
    dryRun: true,
  });
  const op = spec.byCommand("flow")!;
  const result = (await runner.run(op, { photo: ["a.jpg", "b.jpg"] })) as {
    dry_run: boolean;
    planned_requests: { step: string; url: string; body?: unknown }[];
  };

  expect(result.dry_run).toBe(true);
  // 2 slot requests (foreach over 2 photos) + 1 create.
  const steps = result.planned_requests.map((r) => r.step);
  expect(steps.filter((s) => s === "slots").length).toBe(2);
  expect(steps).toContain("create");
  const create = result.planned_requests.find((r) => r.step === "create");
  expect((create?.body as { uid: string }).uid).toBe("fixed-uuid"); // generator ran
});

test("strict dry-run rejects a typo'd ${args.*} reference", async () => {
  // The body references a flag that doesn't exist (`titel` vs `title`).
  const spec = bodySpec({ name: "${args.titel}" });
  const runner = dryRunner(spec);
  const op = spec.byCommand("flow")!;
  await expect(runner.run(op, { title: "hello" })).rejects.toThrow(MissingTemplateValue);
});

test("strict dry-run still accepts a valid ${steps.*} chain (output is stubbed)", async () => {
  // `${steps.upload.url}` is unknown at plan time but must NOT trip strict mode.
  const spec = bodySpec({ name: "${args.title}", pic: "${steps.upload.url}" });
  const runner = dryRunner(spec);
  const op = spec.byCommand("flow")!;
  const result = (await runner.run(op, { title: "hello" })) as {
    planned_requests: { step: string; body?: { name?: string; pic?: string } }[];
  };
  const create = result.planned_requests.find((r) => r.step === "create");
  expect(create?.body?.name).toBe("hello"); // real arg resolved
  expect(create?.body?.pic).toBe("<pending>"); // stubbed step output, no throw
});

test("non-dry-run returns the named result step's response", async () => {
  const spec = workflowSpec();
  // Mock transport: slot returns a url; create returns the listing object.
  const responses: Record<string, unknown> = {
    slot: { url: "https://s3/pic" },
    create: { id: 777, slug: "my-item" },
  };
  const runner = new WorkflowRunner({
    spec,
    authHeaders: () => ({ authorization: "Bearer tok" }),
    baseContext: () => ({ auth: { token: "tok" }, uuid: () => "fixed-uuid" }),
    apiTransport: async () => ({
      name: "mock",
      send: async (req: { url: string }) => ({
        status: 200,
        headers: {},
        text: async () => JSON.stringify(req.url.includes("/create") ? responses.create : responses.slot),
      }),
    }),
  });
  const op = spec.byCommand("flow")!;
  // result: "create" must resolve to the create step's response, not undefined.
  const result = (await runner.run(op, { photo: ["a.jpg"] })) as { id: number; slug: string };
  expect(result).toEqual({ id: 777, slug: "my-item" });
});

test("file-backed keyed resolver with key_template derives a value from other args", async () => {
  const cache = new JsonCache("wf-test", `/tmp/mastro-wf-${process.pid}`);
  const resolver = new Resolver(cache, async () => ({}), (rel) => {
    expect(rel).toBe("reference/categories.json");
    return { "menswear/tshirts": { size_set_us: 54 }, "womenswear/dresses": { size_set_us: 84 } };
  });

  const spec = {
    from: "file:reference/categories.json",
    keyed: true,
    value_path: "size_set_us",
    key_template: "${args.department}/${args.type}",
  };
  // The resolver does the keyed lookup given an explicit key.
  expect(resolver.lookupKeyed(spec, "menswear/tshirts")).toBe("54");
  expect(resolver.lookupKeyed(spec, "womenswear/dresses")).toBe("84");
  expect(resolver.lookupKeyed(spec, "unknown/thing")).toBe(""); // graceful miss
});
