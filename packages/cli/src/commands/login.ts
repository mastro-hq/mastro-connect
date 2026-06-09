/** `mastro login <provider>` — run the browser capture flow and persist auth. */
import type { Provider, PersistedCredential, ValidationResult } from "@mastro/core";
import { Connector } from "@mastro/sdk";

import type { CliContext } from "../context.ts";
import { UsageError } from "../args.ts";
import { ui } from "../output.ts";

export async function login(ctx: CliContext, providerId: string | undefined): Promise<number> {
  if (!providerId) throw new UsageError("usage: mastro login <provider>");

  const provider = ctx.registry.load(providerId);
  ui.heading(`Connecting ${provider.manifest.display_name}`);

  const credential = await ctx.broker.capture(
    provider,
    {
      onBootstrapUrl: (url) => ui.info(`If the browser didn't open, visit:\n  ${url}`),
      onStatus: (msg) => ui.info(msg),
    },
    { verify: verifyCredential },
  );

  ui.success(`Logged in to ${provider.manifest.display_name}.`);
  if (credential.expires_at) {
    ui.info(`Session expires ${new Date(credential.expires_at * 1000).toLocaleString()}.`);
  }
  ui.info(`Try: mastro ${providerId} --help`);
  return 0;
}

/**
 * A liveness probe the broker runs after capture, if the provider's spec
 * declares `x-mastro-auth.verify`. It calls that operation through a real
 * Connector (so the browser proxy / impersonation path is exercised) and
 * returns the structured outcome. Lives in the CLI so the broker stays
 * SDK-free.
 */
async function verifyCredential(
  provider: Provider,
  credential: PersistedCredential,
): Promise<ValidationResult> {
  const connector = Connector.forCredential(provider, credential);
  try {
    return await connector.verify();
  } finally {
    connector.close();
  }
}
