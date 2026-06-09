/** `mastro providers` — list available connectors. */
import type { CliContext } from "../context.ts";
import { emit, pc, ui } from "../output.ts";

export function providers(ctx: CliContext, asJson: boolean): number {
  const ids = ctx.registry.list();
  const rows = ids.map((id) => {
    const p = ctx.registry.load(id);
    const loggedIn = ctx.store.get(id) !== undefined;
    return {
      id,
      display_name: p.manifest.display_name,
      has_api: p.spec !== undefined,
      logged_in: loggedIn,
    };
  });

  if (asJson) {
    emit(rows, true);
    return 0;
  }

  if (rows.length === 0) {
    ui.info("No providers found. Add one under providers/<name>/.");
    return 0;
  }

  ui.heading("Available connectors");
  for (const r of rows) {
    const tick = r.logged_in ? pc.green("✓") : pc.dim("·");
    console.error(`  ${tick} ${pc.bold(r.id.padEnd(14))} ${pc.dim(r.display_name)}`);
  }
  ui.info("\n✓ = logged in.  Run: mastro login <id>");
  return 0;
}
