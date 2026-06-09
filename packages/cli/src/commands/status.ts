/** `mastro status` — show which providers are logged in and freshness. */
import { isExpired, unixNow } from "@mastro/core";

import type { CliContext } from "../context.ts";
import { emit, pc, ui } from "../output.ts";

export function status(ctx: CliContext, asJson: boolean): number {
  const stored = ctx.store.list();
  const rows = stored.map((id) => {
    const cred = ctx.store.get(id)!;
    const expired = isExpired(cred);
    return {
      provider: id,
      state: expired ? "expired" : "active",
      captured_at: cred.captured_at,
      expires_at: cred.expires_at ?? null,
      expires_in_seconds: cred.expires_at ? cred.expires_at - unixNow() : null,
      // null when the provider has no verify op (capture was never probed).
      verified: cred.validation ? cred.validation.ok : null,
      verified_at: cred.validation?.checked_at ?? null,
    };
  });

  if (asJson) {
    emit(rows, true);
    return 0;
  }

  if (rows.length === 0) {
    ui.info("No connectors logged in. Try: mastro login <provider>");
    return 0;
  }

  ui.heading("Logged-in connectors");
  for (const r of rows) {
    const badge = r.state === "active" ? pc.green("● active") : pc.red("● expired");
    // Only show a verification note when the provider actually probed the
    // session — `null` means "not checked", which we leave unannotated.
    const verified =
      r.verified === true
        ? pc.dim(" (verified)")
        : r.verified === false
          ? pc.red(" (verification failed)")
          : "";
    console.error(`  ${badge}  ${pc.bold(r.provider)}${verified}`);
  }
  return 0;
}
