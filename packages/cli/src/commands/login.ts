/** `mastro login <provider>` — run the browser capture flow and persist auth. */
import type { CliContext } from "../context.ts";
import { UsageError } from "../args.ts";
import { ui } from "../output.ts";

export async function login(ctx: CliContext, providerId: string | undefined): Promise<number> {
  if (!providerId) throw new UsageError("usage: mastro login <provider>");

  const provider = ctx.registry.load(providerId);
  ui.heading(`Connecting ${provider.manifest.display_name}`);

  const credential = await ctx.broker.capture(provider, {
    onBootstrapUrl: (url) =>
      ui.info(`If the browser didn't open, visit:\n  ${url}`),
    onStatus: (msg) => ui.info(msg),
  });

  ui.success(`Logged in to ${provider.manifest.display_name}.`);
  if (credential.expires_at) {
    ui.info(`Session expires ${new Date(credential.expires_at * 1000).toLocaleString()}.`);
  }
  ui.info(`Try: mastro ${providerId} --help`);
  return 0;
}
