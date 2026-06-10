/**
 * mastro CLI router.
 *
 *   mastro login <provider>      capture a browser session
 *   mastro logout <provider>     forget a stored session
 *   mastro status                show logged-in connectors
 *   mastro providers [...]       list / fetch / refresh connectors
 *   mastro skills [...]          install agent skills for connectors
 *   mastro extension [...]       install the browser extension
 *   mastro <provider> <command>  call a connector's unofficial API
 *
 * Built-in verbs are handled directly; anything else is treated as a provider
 * id and dispatched dynamically from that provider's OpenAPI operations.
 */
import { createContext } from "./context.ts";
import { login } from "./commands/login.ts";
import { logout } from "./commands/logout.ts";
import { status } from "./commands/status.ts";
import { providers } from "./commands/providers.ts";
import { skills } from "./commands/skills.ts";
import { extension } from "./commands/extension.ts";
import { runConnector } from "./commands/connector.ts";
import { jsonMode, ui } from "./output.ts";
import { VERSION } from "./version.ts";

export async function run(argv: string[]): Promise<number> {
  const asJson = jsonMode(argv);
  const args = argv.filter((a) => a !== "--json");
  const [command, ...rest] = args;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return command ? 0 : 1;
  }
  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return 0;
  }

  const ctx = createContext();

  switch (command) {
    case "login":
      return login(ctx, rest[0]);
    case "logout":
      return logout(ctx, rest[0]);
    case "status":
      return status(ctx, asJson);
    case "providers":
      return providers(ctx, rest, asJson);
    case "skills":
      return skills(ctx, rest, asJson);
    case "extension":
      return extension(ctx, rest, asJson);
    default:
      // Treat `command` as a provider id: `mastro depop search ...`
      return runConnector(ctx, command, rest, asJson);
  }
}

/** Thin wrapper so `bin.ts` stays a one-liner and all errors map to exit codes. */
export async function main(argv: string[]): Promise<number> {
  try {
    return await run(argv);
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Map any thrown value to a clean message + exit code. Every mastro error type
 * (UsageError, NotAuthenticatedError, BrokerError, …) already carries an
 * actionable message, so we print that and exit. An error may opt into a
 * non-default exit code by exposing a numeric `exitCode` (UsageError → 2);
 * everything else exits 1. New error types work without editing this function.
 */
function handleError(err: unknown): number {
  ui.error(err instanceof Error ? err.message : String(err));
  return exitCodeOf(err);
}

function exitCodeOf(err: unknown): number {
  // A handled error is always a failure: honor a custom positive code (e.g.
  // UsageError's 2) but never let an `exitCode: 0` mask the failure as success.
  const code = (err as { exitCode?: unknown } | null)?.exitCode;
  return typeof code === "number" && code > 0 ? code : 1;
}

function printHelp(): void {
  ui.print(`mastro — unofficial connectors for web apps, for agents and humans.

Usage:
  mastro login <provider>        Capture a browser session for a connector
  mastro logout <provider>       Forget a stored session
  mastro status                  Show logged-in connectors
  mastro providers               List available connectors
  mastro providers add <id>      Fetch a connector's latest definition from GitHub
  mastro skills add <id>         Install a connector's agent skills (.claude/skills)
  mastro extension install       Install the browser extension (needed for login)
  mastro <provider> <command>    Call a connector's unofficial API
  mastro <provider> --help       Show a connector's commands

Global flags:
  --json                         Machine-readable output (for agents)
  --version, -v                  Print version

Examples:
  mastro login depop
  mastro depop search "carhartt jacket" --conditions used_good --sizes M
  mastro skills add depop --global`);
}
