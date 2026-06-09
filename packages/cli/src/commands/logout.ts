/** `mastro logout <provider>` — delete a stored credential. */
import type { CliContext } from "../context.ts";
import { UsageError } from "../args.ts";
import { ui } from "../output.ts";

export function logout(ctx: CliContext, providerId: string | undefined): number {
  if (!providerId) throw new UsageError("usage: mastro logout <provider>");
  const removed = ctx.store.delete(providerId);
  if (removed) ui.success(`Removed stored credential for "${providerId}".`);
  else ui.warn(`No stored credential for "${providerId}".`);
  return 0;
}
