/**
 * Drift guard for the extension's hand-maintained type mirror.
 *
 * `extension/types.d.ts` re-declares the manifest shape as ambient types so the
 * plain-JS extension can be checkJs-verified without importing @mastro/core.
 * Nothing fails at build time when the canonical contract changes and the mirror
 * doesn't — they just silently diverge until a capture breaks at runtime.
 *
 * The JSON schema (browser-auth-manifest.schema.json) is the runtime authority:
 * every manifest is validated against it. This test asserts that every field
 * name the schema knows about also appears in the extension's mirror, so adding
 * a capture field to the schema without teaching the extension to read it fails
 * here instead of in production. It's a name-level check, not a full structural
 * one — cheap, and it catches the realistic drift (a renamed/added field).
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "../src/schemas/browser-auth-manifest.schema.json");
const extTypesPath = join(here, "../../../extension/types.d.ts");

/** Field names the extension intentionally doesn't read (server/CLI-only). */
const EXTENSION_IGNORES = new Set([
  // The extension captures, it doesn't decide policy or persistence.
  "observes_cookies",
  "observes_request_headers",
  "observes_request_body",
  "observes_response_headers",
  "observes_storage",
  "persist_minimum",
  "expected_origins",
  "redact_fields",
]);

/** Collect every `properties` key name declared anywhere in the JSON schema. */
function schemaFieldNames(schema: unknown, into = new Set<string>()): Set<string> {
  if (!schema || typeof schema !== "object") return into;
  const obj = schema as Record<string, unknown>;
  if (obj.properties && typeof obj.properties === "object") {
    for (const key of Object.keys(obj.properties)) into.add(key);
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") schemaFieldNames(value, into);
  }
  return into;
}

test("every manifest field in the schema is present in extension/types.d.ts", () => {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const extText = readFileSync(extTypesPath, "utf8");

  const fields = [...schemaFieldNames(schema)].filter((f) => !EXTENSION_IGNORES.has(f));
  // Word-boundary match so a short name (e.g. "url") isn't spuriously satisfied
  // by a longer token ("launchUrl"). `\b` treats `_` as a word char, so
  // snake_case field names match exactly.
  const missing = fields.filter((f) => !new RegExp(`\\b${f}\\b`).test(extText));

  expect(
    missing,
    `extension/types.d.ts is missing manifest field(s) the schema declares: ` +
      `${missing.join(", ")}. Update the mirror (or add to EXTENSION_IGNORES if ` +
      `the extension legitimately doesn't read it).`,
  ).toEqual([]);
});
