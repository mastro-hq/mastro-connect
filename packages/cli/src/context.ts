/**
 * Shared CLI dependencies, wired once and passed to every command.
 * Keeps commands free of construction logic and easy to test.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AuthBroker, FileStore, ProviderRegistry, type CredentialStore } from "@mastro/core";

export interface CliContext {
  registry: ProviderRegistry;
  store: CredentialStore;
  broker: AuthBroker;
}

/**
 * Provider search roots, in priority order:
 *   1. $MASTRO_PROVIDERS (colon-separated) — user/local overrides
 *   2. the repo's bundled `providers/` directory
 */
function providerRoots(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = resolve(here, "../../../providers");
  const env = process.env.MASTRO_PROVIDERS;
  const fromEnv = env ? env.split(":").map((p) => resolve(p)) : [];
  return [...fromEnv, bundled];
}

export function createContext(): CliContext {
  const registry = new ProviderRegistry(providerRoots());
  const store = new FileStore();
  const broker = new AuthBroker(store);
  return { registry, store, broker };
}
