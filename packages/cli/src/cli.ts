/**
 * mastro CLI router.
 *
 *   mastro login <provider>      capture a browser session
 *   mastro logout <provider>     forget a stored session
 *   mastro status                show logged-in connectors
 *   mastro providers             list available connectors
 *   mastro <provider> <command>  call a connector's unofficial API
 *
 * Built-in verbs are handled directly; anything else is treated as a provider
 * id and dispatched dynamically from that provider's OpenAPI operations.
 */
import {
  BrokerError,
  ProviderNotFoundError,
  SchemaError,
} from "@mastro/core";
import { NotAuthenticatedError, RecaptureRequiredError, ApiError } from "@mastro/sdk";

import { UsageError } from "./args.ts";
import { createContext } from "./context.ts";
import { login } from "./commands/login.ts";
import { logout } from "./commands/logout.ts";
import { status } from "./commands/status.ts";
import { providers } from "./commands/providers.ts";
import { runConnector } from "./commands/connector.ts";
import { jsonMode, ui } from "./output.ts";

const VERSION = "0.1.0";

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
      return providers(ctx, asJson);
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

function handleError(err: unknown): number {
  if (err instanceof UsageError) {
    ui.error(err.message);
    return 2;
  }
  if (err instanceof ProviderNotFoundError) {
    ui.error(err.message);
    return 1;
  }
  if (err instanceof NotAuthenticatedError || err instanceof RecaptureRequiredError) {
    ui.error(err.message);
    return 1;
  }
  if (err instanceof BrokerError) {
    ui.error(err.message);
    return 1;
  }
  if (err instanceof ApiError) {
    ui.error(err.message);
    return 1;
  }
  if (err instanceof SchemaError) {
    ui.error(err.message);
    return 1;
  }
  ui.error(err instanceof Error ? err.message : String(err));
  return 1;
}

function printHelp(): void {
  console.error(`mastro — unofficial connectors for web apps, for agents and humans.

Usage:
  mastro login <provider>        Capture a browser session for a connector
  mastro logout <provider>       Forget a stored session
  mastro status                  Show logged-in connectors
  mastro providers               List available connectors
  mastro <provider> <command>    Call a connector's unofficial API
  mastro <provider> --help       Show a connector's commands

Global flags:
  --json                         Machine-readable output (for agents)
  --version, -v                  Print version

Examples:
  mastro login depop
  mastro depop search "carhartt jacket" --conditions used_good --sizes M
  mastro depop search "vintage tee" --json`);
}
