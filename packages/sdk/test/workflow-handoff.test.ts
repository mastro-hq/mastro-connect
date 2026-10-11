/**
 * Workflow features for stage-then-hand-off flows (ReserveCalifornia's
 * reserve → cart → pay in the browser): in-band failure checks (`fail_when`),
 * per-operation servers/transport/public auth, and the browser `handoff`.
 */
import { expect, test } from "bun:test";

import { OpenApiSpec, type OpenApiDocument, type TransportKind } from "@mastro/core";
import { WorkflowError, WorkflowRunner, type HttpRequest, type Transport } from "../src/index.ts";

const PUBLIC_HOST = "https://search.example.com";

function spec(): OpenApiSpec {
  const doc: OpenApiDocument = {
    openapi: "3.1.0",
    info: { title: "stage", version: "1" },
    servers: [{ url: "https://api.example.com" }],
    "x-mastro-auth": { headers: { authorization: "Bearer ${auth.token}" }, redact: ["x-secret"] },
    paths: {
      "/x/book": {
        post: {
          operationId: "book",
          "x-mastro-command": "book",
          "x-mastro-args": [{ name: "site", required: true }],
          "x-mastro-workflow": {
            result: "add",
            steps: [
              { id: "find", operationId: "find" },
              {
                id: "add",
                operationId: "add",
                request: { body: { site: "${args.site}", ref: "${steps.find.ref}" } },
                fail_when: ["${steps.add.Message}", "${steps.add.Result.ErrorMessage}"],
              },
            ],
            handoff: {
              url: "https://app.example.com/cart",
              local_storage: { cartKey: "${steps.add.Result.Key}" },
            },
          },
        },
      },
      // Public, on its own host, sent directly — never with the credential.
      "/find": {
        get: {
          operationId: "find",
          "x-mastro-hidden": true,
          servers: [{ url: PUBLIC_HOST }],
          security: [],
          "x-mastro-transport": "direct",
        },
      },
      "/add": { post: { operationId: "add", "x-mastro-hidden": true } },
    },
  };
  return new OpenApiSpec(doc);
}

interface Sent extends HttpRequest {
  kind: TransportKind | undefined;
}

/** A runner over canned responses (by URL path), recording every send. */
function runner(addResponse: unknown, handoffs: { url: string; ls: Record<string, string> }[] = []) {
  const sent: Sent[] = [];
  const r = new WorkflowRunner({
    spec: spec(),
    authHeaders: () => ({ authorization: "Bearer tok" }),
    baseContext: () => ({ auth: { token: "tok" } }),
    transport: async (kind): Promise<Transport> => ({
      name: kind ?? "default",
      send: async (req) => {
        sent.push({ ...req, kind });
        const body = new URL(req.url).pathname === "/find" ? { ref: "r-1" } : addResponse;
        return { status: 200, headers: {}, text: async () => JSON.stringify(body) };
      },
    }),
    handoff: async (url, ls) => {
      handoffs.push({ url, ls });
    },
  });
  return { r, sent, op: spec().byCommand("book")! };
}

test("a public operation uses its own server, the direct transport, and no auth", async () => {
  const { r, sent, op } = runner({ Response: 1, Result: { ErrorMessage: "", Key: "k-9" } });
  await r.run(op, { site: "42" });

  const [find, add] = sent;
  expect(find?.url).toBe(`${PUBLIC_HOST}/find`);
  expect(find?.kind).toBe("direct");
  expect(find?.headers.authorization).toBeUndefined();

  expect(add?.url).toBe("https://api.example.com/add");
  expect(add?.kind).toBeUndefined(); // spec default
  expect(add?.headers.authorization).toBe("Bearer tok");
  expect(JSON.parse(String(add?.body))).toEqual({ site: "42", ref: "r-1" });
});

test("fail_when turns an in-band error on a 2xx into a WorkflowError with its message", async () => {
  const { r, op } = runner({ Response: 1, Result: { ErrorMessage: "Site is not available." } });
  const err = await r.run(op, { site: "42" }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkflowError);
  expect((err as WorkflowError).message).toContain("Site is not available.");
});

test("fail_when checks the envelope too (Message on a non-1 Response)", async () => {
  const { r, op } = runner({ Response: 2, Message: "Session expired" });
  await expect(r.run(op, { site: "42" })).rejects.toThrow(/Session expired/);
});

test("a failed step never hands off", async () => {
  const handoffs: { url: string; ls: Record<string, string> }[] = [];
  const { r, op } = runner({ Response: 2, Message: "nope" }, handoffs);
  await r.run(op, { site: "42" }).catch(() => {});
  expect(handoffs).toEqual([]);
});

test("success hands off with rendered storage, then returns the result", async () => {
  const handoffs: { url: string; ls: Record<string, string> }[] = [];
  const { r, op } = runner({ Response: 1, Result: { ErrorMessage: "", Key: "k-9" } }, handoffs);
  const result = await r.run(op, { site: "42" });
  expect(handoffs).toEqual([{ url: "https://app.example.com/cart", ls: { cartKey: "k-9" } }]);
  expect(result).toEqual({ Response: 1, Result: { ErrorMessage: "", Key: "k-9" } });
});

test("dry-run lists the handoff instead of performing it, and redacts spec-declared headers", async () => {
  const handoffs: { url: string; ls: Record<string, string> }[] = [];
  const r = new WorkflowRunner({
    spec: spec(),
    authHeaders: () => ({ authorization: "Bearer tok", "x-secret": "s3cret" }),
    baseContext: () => ({ auth: { token: "tok" } }),
    transport: async () => {
      throw new Error("must not send in dry-run");
    },
    handoff: async (url, ls) => {
      handoffs.push({ url, ls });
    },
    dryRun: true,
  });
  const plan = (await r.run(spec().byCommand("book")!, { site: "42" })) as {
    planned_requests: { headers: Record<string, string> }[];
    handoff: { url: string; local_storage: Record<string, string> };
  };
  expect(handoffs).toEqual([]);
  expect(plan.handoff).toEqual({ url: "https://app.example.com/cart", local_storage: { cartKey: "<pending>" } });
  expect(plan.planned_requests[1]?.headers).toEqual({
    authorization: "••••",
    "x-secret": "••••",
    "content-type": "application/json",
  });
});
