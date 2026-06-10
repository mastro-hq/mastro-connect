#!/usr/bin/env node
// @ts-check
/**
 * Node-compatible launcher for the mastro CLI.
 *
 * The CLI runs on Bun (it uses Bun.serve / Bun.YAML / Bun.spawn), but npx and
 * global installs execute bins with Node. This shim hands off to Bun, and
 * gives a clear install message instead of a crash when Bun is missing.
 */
"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const packageRoot = join(__dirname, "..");
const bundled = join(packageRoot, "dist", "bin.js");
// In a repo checkout there is no dist/ — run the TypeScript entry directly.
const entry = existsSync(bundled) ? bundled : join(packageRoot, "packages", "cli", "src", "bin.ts");

const result = spawnSync("bun", [entry, ...process.argv.slice(2)], { stdio: "inherit" });

if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
  console.error(
    "mastro needs the Bun runtime (it drives a local capture server Bun provides).\n" +
      "Install it once:  curl -fsSL https://bun.sh/install | bash   (or: brew install oven-sh/bun/bun)\n" +
      "Then re-run this command.",
  );
  process.exit(1);
}
if (result.error) {
  console.error(`mastro failed to start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
