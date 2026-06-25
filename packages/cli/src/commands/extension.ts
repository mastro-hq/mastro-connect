/**
 * `mastro extension` — set up the browser extension outside the repo.
 *
 * `mastro login` needs the mastro extension running in the user's Chrome to
 * capture a session. The extension ships inside the npm package; `install`
 * copies it to a stable path (~/.mastro/extension) and prints the
 * load-unpacked steps, so npx users aren't stranded at first login.
 *
 * Chrome offers no CLI to load an unpacked extension into a running profile —
 * that manual click is unavoidable short of a Web Store listing. So `install`
 * smooths it instead: it copies the dest path to the clipboard and best-effort
 * opens chrome://extensions, turning "find the folder" into "Load unpacked, paste".
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

import { UsageError } from "../args.ts";
import { packageRoot, type CliContext } from "../context.ts";
import { emit, ui } from "../output.ts";
import { mastroHome } from "@mastro/core";

export function extension(_ctx: CliContext, rest: string[], asJson: boolean): number {
  const [sub, ...flags] = rest;
  switch (sub) {
    case "install":
      return install(asJson, !flags.includes("--no-open"));
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

function install(asJson: boolean, open: boolean): number {
  const source = join(packageRoot(), "extension");
  if (!existsSync(join(source, "manifest.json"))) {
    throw new Error("this mastro install does not bundle the extension — reinstall the package.");
  }
  const dest = installedDir();
  cpSync(source, dest, { recursive: true });

  const copied = copyToClipboard(dest);
  const opened = open ? openExtensionsPage() : false;

  if (asJson) {
    emit({ installed: dest, pathCopied: copied, pageOpened: opened }, true);
    return 0;
  }
  ui.success(`Extension copied to ${dest}`);
  // The path is already on the clipboard, so step 3 collapses to a paste.
  const pickStep = copied
    ? `Click "Load unpacked", paste (the path is on your clipboard), and confirm`
    : `Click "Load unpacked" and pick: ${dest}`;
  const openStep = opened
    ? `chrome://extensions is open in Chrome`
    : `Open chrome://extensions`;
  ui.info(`
Load it in Chrome (one time):
  1. ${openStep}
  2. Toggle "Developer mode" (top right)
  3. ${pickStep}

Then run \`mastro login <provider>\`. After a mastro update, re-run
\`mastro extension install\` and hit ↻ on the extension card.`);
  return 0;
}

/** A program to invoke: an executable plus its argument vector. */
interface Command {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * Copy text to the OS clipboard via the native tool, so step 3 is a paste, not
 * a folder hunt. Best-effort: a missing tool (e.g. no `xclip` on a headless
 * Linux box) just returns false and we fall back to the printed path. Uses
 * spawnSync's `input` to feed stdin a string without any shell quoting.
 */
function copyToClipboard(text: string): boolean {
  const cmd: Command =
    process.platform === "darwin"
      ? { file: "pbcopy", args: [] }
      : process.platform === "win32"
        ? { file: "clip", args: [] }
        : { file: "xclip", args: ["-selection", "clipboard"] };
  const res = spawnSync(cmd.file, [...cmd.args], { input: text });
  return res.status === 0 && res.error === undefined;
}

/**
 * Best-effort open of chrome://extensions. The OS won't route a chrome:// URL
 * (it's browser-internal, not a registered protocol), so we launch the Chrome
 * binary with the URL as an argument. A detached, unref'd spawn means we don't
 * block on or own the browser process. Returns false if no Chrome is found.
 */
function openExtensionsPage(): boolean {
  const url = "chrome://extensions";
  const candidates: readonly Command[] =
    process.platform === "darwin"
      ? [{ file: "open", args: ["-a", "Google Chrome", url] }]
      : process.platform === "win32"
        ? [{ file: "cmd", args: ["/c", "start", "chrome", url] }]
        : [
            { file: "google-chrome", args: [url] },
            { file: "google-chrome-stable", args: [url] },
            { file: "chromium", args: [url] },
          ];
  for (const c of candidates) {
    // spawn reports a missing binary asynchronously via 'error', not by throwing
    // here, so on Linux we can't tell which candidate actually launched. Probe
    // first with a sync existence check, then launch detached so we don't own
    // the browser process.
    if (!onPath(c.file)) continue;
    const child = spawn(c.file, [...c.args], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  }
  return false;
}

/** Whether an executable is resolvable on PATH (or absolute), via the OS locator. */
function onPath(file: string): boolean {
  const locator = process.platform === "win32" ? "where" : "which";
  return spawnSync(locator, [file], { stdio: "ignore" }).status === 0;
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
  mastro extension install    Copy the bundled extension to ~/.mastro/extension,
                              copy that path to the clipboard, and open
                              chrome://extensions ready for "Load unpacked".
    --no-open                 Skip opening chrome://extensions.
  mastro extension path       Print where it lives (and whether it's installed)`);
}
