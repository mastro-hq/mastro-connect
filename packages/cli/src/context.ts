/**
 * Shared CLI dependencies, wired once and passed to every command.
 * Keeps commands free of construction logic and easy to test.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AuthBroker, FileStore, ProviderRegistry, mastroHome, type CredentialStore } from "@mastro/core";

export interface CliContext {
  registry: ProviderRegistry;
  store: CredentialStore;
  broker: AuthBroker;
}

/** The user-managed provider root that `mastro providers add` writes into. */
export function userProvidersDir(): string {
  return join(mastroHome(), "providers");
}

/**
 * The installed package root — the directory that ships `providers/` and
 * `skills/`. Found by walking up from this module, so it works both from the
 * repo (packages/cli/src/) and from the published bundle (dist/).
 */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    if (existsSync(join(dir, "providers")) && existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("mastro install is broken: cannot locate the bundled providers/ directory.");
}

/**
 * Provider search roots, in priority order:
 *   1. $MASTRO_PROVIDERS (colon-separated) — explicit overrides
 *   2. ~/.mastro/providers — fetched via `mastro providers add`
 *   3. the package's bundled `providers/` directory
 */
function providerRoots(): string[] {
  const env = process.env.MASTRO_PROVIDERS;
  const fromEnv = env ? env.split(":").map((p) => resolve(p)) : [];
  return [...fromEnv, userProvidersDir(), join(packageRoot(), "providers")];
}

export function createContext(): CliContext {
  const registry = new ProviderRegistry(providerRoots());
  const store = new FileStore();
  const broker = new AuthBroker(store);
  return { registry, store, broker };
}
