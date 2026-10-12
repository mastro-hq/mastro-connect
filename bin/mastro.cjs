#!/usr/bin/env node
// @ts-check
/**
 * Node-compatible launcher for the mastro CLI.
 *
 * The CLI runs on Bun (it uses Bun.serve / Bun.YAML / Bun.spawn), but npx and
 * global installs execute bins with Node. This shim hands off to Bun:
 *
 *   1. $MASTRO_BUN, if set (an explicit binary);
 *   2. the Bun binary npm installed alongside mastro — one of the
 *      `@oven/bun-<platform>` optionalDependencies, each tagged with os/cpu/libc
 *      so npm fetches only the one matching this machine (no postinstall);
 *   3. `bun` on PATH (e.g. installs that skipped optional dependencies).
 *
 * So `npx mastro-connect …` works on a machine that has never seen Bun.
 */
"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");

const packageRoot = join(__dirname, "..");
const bundled = join(packageRoot, "dist", "bin.js");
// In a repo checkout there is no dist/ — run the TypeScript entry directly.
const entry = existsSync(bundled) ? bundled : join(packageRoot, "packages", "cli", "src", "bin.ts");

/** @type {Record<string, readonly string[]>} platform+arch → candidate packages, preferred first */
const BUN_PACKAGES = {
  "darwin arm64": ["@oven/bun-darwin-aarch64"],
  "darwin x64": ["@oven/bun-darwin-x64"],
  "linux arm64": ["@oven/bun-linux-aarch64", "@oven/bun-linux-aarch64-musl"],
  "linux x64": ["@oven/bun-linux-x64", "@oven/bun-linux-x64-musl"],
  "win32 arm64": ["@oven/bun-windows-aarch64"],
  "win32 x64": ["@oven/bun-windows-x64"],
};

/** The Bun binary npm installed for this platform, if any. */
function bundledBun() {
  const exe = process.platform === "win32" ? "bun.exe" : "bun";
  for (const pkg of BUN_PACKAGES[`${process.platform} ${process.arch}`] ?? []) {
    try {
      const bin = join(dirname(require.resolve(`${pkg}/package.json`)), "bin", exe);
      if (existsSync(bin)) return bin;
    } catch {
      // not installed for this platform — try the next candidate
    }
  }
  return undefined;
}

const bun = process.env.MASTRO_BUN || bundledBun() || "bun";
const result = spawnSync(bun, [entry, ...process.argv.slice(2)], { stdio: "inherit" });

if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
  console.error(
    `mastro couldn't find the Bun runtime for ${process.platform}/${process.arch}.\n` +
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
