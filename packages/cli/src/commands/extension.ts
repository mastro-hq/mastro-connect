/**
 * `mastro extension` — set up the browser extension outside the repo.
 *
 * `mastro login` needs the mastro extension running in the user's Chrome to
 * capture a session. The extension ships inside the npm package; `install`
 * copies it to a stable path (~/.mastro/extension) and prints the
 * load-unpacked steps, so npx users aren't stranded at first login.
 */
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

import { UsageError } from "../args.ts";
import { packageRoot, type CliContext } from "../context.ts";
import { emit, ui } from "../output.ts";
import { mastroHome } from "@mastro/core";

export function extension(_ctx: CliContext, rest: string[], asJson: boolean): number {
  const [sub] = rest;
  switch (sub) {
    case "install":
      return install(asJson);
    case "path":
      return path(asJson);
    case undefined:
    case "--help":
    case "-h":
      printHelp();
      return sub === undefined ? 1 : 0;
    default:
      throw new UsageError(`unknown extension subcommand "${sub}". Try: install, path.`);
  }
}

function installedDir(): string {
  return join(mastroHome(), "extension");
}

function install(asJson: boolean): number {
  const source = join(packageRoot(), "extension");
  if (!existsSync(join(source, "manifest.json"))) {
    throw new Error("this mastro install does not bundle the extension — reinstall the package.");
  }
  const dest = installedDir();
  cpSync(source, dest, { recursive: true });

  if (asJson) {
    emit({ installed: dest }, true);
    return 0;
  }
  ui.success(`Extension copied to ${dest}`);
  ui.info(`
Load it in Chrome (one time):
  1. Open chrome://extensions
  2. Toggle "Developer mode" (top right)
  3. Click "Load unpacked" and pick: ${dest}

Then run \`mastro login <provider>\`. After a mastro update, re-run
\`mastro extension install\` and hit ↻ on the extension card.`);
  return 0;
}

function path(asJson: boolean): number {
  const dest = installedDir();
  const installed = existsSync(join(dest, "manifest.json"));
  if (asJson) {
    emit({ path: dest, installed }, true);
    return 0;
  }
  console.log(dest);
  if (!installed) ui.warn("not installed yet — run `mastro extension install`");
  return 0;
}

function printHelp(): void {
  ui.print(`mastro extension — install the browser extension mastro login needs.

Usage:
  mastro extension install    Copy the bundled extension to ~/.mastro/extension
  mastro extension path       Print where it lives (and whether it's installed)`);
}
