import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateDir } from "../src/commands/validate.ts";

const EXAMPLE = join(import.meta.dir, "..", "..", "..", "providers", "hackernews");

/** A scratch copy of the bundled example connector to break on purpose. */
function exampleCopy(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "mastro-validate-")), "hackernews");
  cpSync(EXAMPLE, dir, { recursive: true });
  return dir;
}

function edit(path: string, from: string, to: string): void {
  const text = readFileSync(path, "utf8");
  if (!text.includes(from)) throw new Error(`fixture drifted: "${from}" not in ${path}`);
  writeFileSync(path, text.replace(from, to));
}

describe("validateDir", () => {
  test("the bundled example connector is clean", () => {
    const report = validateDir(EXAMPLE);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.commands).toBe(3);
  });

  test("flags a workflow step calling a missing operation", () => {
    const dir = exampleCopy();
    edit(join(dir, "openapi.yaml"), "operationId: topIds\n            request:", "operationId: nope\n            request:");
    expect(validateDir(dir).errors).toContain('top: step "ids" calls unknown operationId "nope"');
  });

  test("flags a template reading an undeclared flag", () => {
    const dir = exampleCopy();
    edit(join(dir, "openapi.yaml"), "${args.limit|10}", "${args.count|10}");
    expect(validateDir(dir).errors).toContain("top: template reads ${args.count} but there is no --count flag");
  });

  test("flags a step reading a later step", () => {
    const dir = exampleCopy();
    edit(join(dir, "openapi.yaml"), "limitToFirst=${args.limit|10}", "limitToFirst=${steps.stories.length}");
    expect(validateDir(dir).errors).toContain('top: step "ids" reads ${steps.stories} before it runs');
  });

  test("flags a manifest whose provider_id doesn't match the directory", () => {
    const dir = exampleCopy();
    edit(join(dir, "auth.manifest.json"), '"provider_id": "hackernews"', '"provider_id": "hn"');
    expect(validateDir(dir).errors[0]).toContain('provider_id "hn"');
  });

  test("flags skills without the mastro-<id>- prefix", () => {
    const dir = exampleCopy();
    edit(join(dir, "skills", "read", "SKILL.md"), "name: mastro-hackernews-read", "name: hn-read");
    expect(validateDir(dir).errors).toContain(
      'skills/read: frontmatter name "hn-read" should start with "mastro-hackernews-"',
    );
  });

  test("rejects committed HARs and live-looking tokens", () => {
    const dir = exampleCopy();
    writeFileSync(join(dir, "capture.har"), '{"log":{"version":"1.2","entries":[]}}');
    writeFileSync(join(dir, "notes.md"), `authorization: Bearer ${"a1B2".repeat(12)}\n`);
    const { errors } = validateDir(dir);
    expect(errors).toContain("capture.har: HAR files hold live cookies and tokens — never commit them");
    expect(errors).toContain("notes.md: contains what looks like a live bearer token");
  });

  test("warns when no rate limit is set", () => {
    const dir = exampleCopy();
    edit(join(dir, "openapi.yaml"), "  rate_limit:\n    requests_per_minute: 120\n", "");
    expect(validateDir(dir).warnings[0]).toContain("rate_limit is not set");
  });
});
