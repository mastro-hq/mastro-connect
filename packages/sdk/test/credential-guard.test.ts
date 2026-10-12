import { describe, expect, test } from "bun:test";

import { CredentialScope, CredentialScopeError } from "../src/index.ts";

const scope = new CredentialScope("app", { token: "s3cr3t-token-value", user_id: "42" }, ["https://app.example.com"]);

describe("CredentialScope", () => {
  test("credential material may go to an origin the user logged in for", () => {
    expect(() => scope.check("https://app.example.com/api", ["Bearer s3cr3t-token-value"])).not.toThrow();
  });

  test("credential material bound for any other origin is refused — header, body, or URL", () => {
    expect(() => scope.check("https://evil.example/x", ["Bearer s3cr3t-token-value"])).toThrow(CredentialScopeError);
    expect(() => scope.check("https://evil.example/x", ['{"t":"s3cr3t-token-value"}'])).toThrow(CredentialScopeError);
    expect(() => scope.check("https://evil.example/x?t=s3cr3t-token-value", [])).toThrow(CredentialScopeError);
  });

  test("requests without credential material go anywhere (public APIs, presigned uploads)", () => {
    expect(() => scope.check("https://s3.example/upload?sig=abc", ["content-type: image/jpeg"])).not.toThrow();
  });

  test("short values like numeric ids aren't policed (too likely to appear in public data)", () => {
    expect(() => scope.check("https://other.example/users/42", ["42"])).not.toThrow();
  });
});

describe("CredentialScope — encodings and the browser rule", () => {
  const b64 = new CredentialScope("app", { cookie: "abc+def/ghi=jkl==", jsession: '"ajax:12345678"' }, [
    "https://app.example.com",
  ]);

  test("a secret percent- or form-encoded into a query or body is still caught", () => {
    expect(() => b64.check(`https://evil.example/x?t=${encodeURIComponent("abc+def/ghi=jkl==")}`, [])).toThrow(
      CredentialScopeError,
    );
    expect(() => b64.check("https://evil.example/x", [new URLSearchParams({ t: "abc+def/ghi=jkl==" }).toString()])).toThrow(
      CredentialScopeError,
    );
  });

  test("a quoted cookie value sent unquoted is still caught", () => {
    expect(() => b64.check("https://evil.example/x", ["csrf-token: ajax:12345678"])).toThrow(CredentialScopeError);
  });

  test("a binary body carrying a secret is caught", async () => {
    const transport = { name: "t", send: async () => ({ status: 200, headers: {}, text: async () => "" }) };
    const guarded = b64.guard(transport);
    const body = new TextEncoder().encode("token=abc+def/ghi=jkl==") as Uint8Array<ArrayBuffer>;
    const outcome = await guarded.send({ method: "POST", url: "https://evil.example/u", headers: {}, body }).catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(CredentialScopeError);
  });

  test("anything through the browser tab must target a logged-in origin, token or not", async () => {
    const transport = { name: "browser", send: async () => ({ status: 200, headers: {}, text: async () => "" }) };
    const guarded = b64.guard(transport, { tabOrigin: undefined });
    const outcome = await guarded.send({ method: "GET", url: "https://other-site.example/public", headers: {} }).catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(CredentialScopeError);
  });

  test("a provider never logged in to can't use the browser at all", () => {
    const anonymous = new CredentialScope("app", {}, []);
    expect(() => anonymous.requireOrigin("https://app.example.com/")).toThrow(CredentialScopeError);
  });
});
