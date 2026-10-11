/**
 * Loading a provider, installing it from the catalog on first use.
 *
 * mastro ships no connectors: `mastro hackernews top` on a fresh machine finds
 * nothing installed, fetches `hackernews` from the default catalog
 * (mastro-hq/connectors, commit-pinned into ~/.mastro/providers), and carries
 * on — no prompt, so agents never block. Only the curated default catalog
 * auto-installs; any other repo needs an explicit `providers add --repo`.
 * The one-line notice is a progress note (stdout) for humans, but goes to
 * stderr under `--json` so the JSON stays the only thing on stdout.
 */
import { ProviderNotFoundError, type Provider } from "@mastro/core";

import { UsageError } from "./args.ts";
import type { CliContext } from "./context.ts";
import { ui } from "./output.ts";
import {
  DEFAULT_REF,
  DEFAULT_REPO,
  fetchProvider,
  ProviderNotInRepoError,
  type ProviderLockEntry,
} from "./provider-fetch.ts";

/** Fetches one provider from the catalog; injectable for tests. */
export type CatalogInstaller = (id: string) => Promise<ProviderLockEntry>;

export interface EnsureOptions {
  /** The command is in --json mode: keep the install notice off stdout. */
  asJson?: boolean;
  install?: CatalogInstaller;
}

const installFromCatalog: CatalogInstaller = (id) => fetchProvider(id, DEFAULT_REPO, DEFAULT_REF);

/** Provider ids are directory names in a repo: keep auto-install to plain slugs. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function ensureProvider(
  ctx: CliContext,
  id: string,
  { asJson = false, install = installFromCatalog }: EnsureOptions = {},
): Promise<Provider> {
  try {
    return ctx.registry.load(id);
  } catch (err) {
    if (!(err instanceof ProviderNotFoundError) || !PROVIDER_ID.test(id)) throw err;
    let entry: ProviderLockEntry;
    try {
      entry = await install(id);
    } catch (installErr) {
      // Anything other than "not in the catalog" (offline, rate limit) says why.
      if (!(installErr instanceof ProviderNotInRepoError)) throw installErr;
      throw new UsageError(
        `no connector "${id}" — it isn't installed and isn't in the catalog. ` +
          "See `mastro providers available`, or build it: `mastro skills add mastro-author`.",
      );
    }
    const notice = `installed ${id} from ${entry.repo} @ ${entry.commit.slice(0, 7)}`;
    if (asJson) console.error(notice);
    else ui.info(notice);
    return ctx.registry.load(id);
  }
}
