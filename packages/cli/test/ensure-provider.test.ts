import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthBroker, FileStore, ProviderNotFoundError, ProviderRegistry } from "@mastro/core";

import { UsageError } from "../src/args.ts";
import type { CliContext } from "../src/context.ts";
import { ensureProvider, type CatalogInstaller } from "../src/ensure-provider.ts";
import { FetchError, ProviderNotInRepoError, type ProviderLockEntry } from "../src/provider-fetch.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "providers");

/** A context whose only provider root starts empty. */
function emptyContext(): { ctx: CliContext; root: string } {
  const root = mkdtempSync(join(tmpdir(), "mastro-ensure-"));
  const store = new FileStore(join(root, ".creds"));
  return { ctx: { registry: new ProviderRegistry([root]), store, broker: new AuthBroker(store, () => {}) }, root };
}

const ENTRY: ProviderLockEntry = {
  repo: "mastro-hq/connectors",
  ref: "main",
  commit: "0123456789abcdef",
  fetched_at: "2026-10-11T00:00:00.000Z",
};

describe("ensureProvider", () => {
  test("loads an installed provider without touching the catalog", async () => {
    const { ctx, root } = emptyContext();
    cpSync(join(FIXTURES, "hackernews"), join(root, "hackernews"), { recursive: true });
    let calls = 0;
    const install: CatalogInstaller = async () => {
      calls++;
      return ENTRY;
    };
    const provider = await ensureProvider(ctx, "hackernews", { install });
    expect(provider.id).toBe("hackernews");
    expect(calls).toBe(0);
  });

  test("installs a missing provider from the catalog, then loads it", async () => {
    const { ctx, root } = emptyContext();
    const installed: string[] = [];
    const install: CatalogInstaller = async (id) => {
      installed.push(id);
      cpSync(join(FIXTURES, id), join(root, id), { recursive: true });
      return ENTRY;
    };
    const provider = await ensureProvider(ctx, "hackernews", { install });
    expect(installed).toEqual(["hackernews"]);
    expect(provider.spec?.commands().map((op) => op.command)).toContain("top");
  });

  test("an id the catalog doesn't have points at the catalog and the authoring skill", async () => {
    const { ctx } = emptyContext();
    const install: CatalogInstaller = async (id) => {
      throw new ProviderNotInRepoError(id, ENTRY.repo, ENTRY.ref);
    };
    const failure = ensureProvider(ctx, "nosuchapp", { install });
    await expect(failure).rejects.toBeInstanceOf(UsageError);
    await expect(failure).rejects.toThrow(/isn't in the catalog.*mastro-author/);
  });

  test("surfaces why the catalog couldn't be reached", async () => {
    const { ctx } = emptyContext();
    const install: CatalogInstaller = async () => {
      throw new FetchError("GitHub API rate limit hit");
    };
    await expect(ensureProvider(ctx, "hackernews", { install })).rejects.toThrow("rate limit");
  });

  test("never tries to install an id that isn't a plain slug", async () => {
    const { ctx } = emptyContext();
    let calls = 0;
    const install: CatalogInstaller = async () => {
      calls++;
      return ENTRY;
    };
    await expect(ensureProvider(ctx, "../etc", { install })).rejects.toBeInstanceOf(ProviderNotFoundError);
    await expect(ensureProvider(ctx, "Some App", { install })).rejects.toBeInstanceOf(ProviderNotFoundError);
    expect(calls).toBe(0);
  });
});
