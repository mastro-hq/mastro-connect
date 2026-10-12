/**
 * Dynamic per-provider dispatch: `mastro <provider> <command> [flags]`.
 *
 * Commands aren't hard-coded — they're the operations in the provider's OpenAPI
 * spec (operationId / x-mastro-command). Flags are the operation's parameters;
 * their choices come from `schema.enum`. This is what makes a connector
 * "data, not code".
 */
import type { OperationView, Provider } from "@mastro/core";
import { Connector } from "@mastro/sdk";

import {
  buildArgsMap,
  flagFromParameter,
  flagFromWorkflowArg,
  parseArgs,
  type CliFlag,
} from "../args.ts";
import type { CliContext } from "../context.ts";
import { ensureProvider } from "../ensure-provider.ts";
import { emit, pc, ui } from "../output.ts";

/**
 * The CLI flags for an operation — a workflow's x-mastro-args, or a single
 * request's parameters plus any x-mastro-args (template-only flags that feed
 * x-mastro-body / x-mastro-headers without also landing in the URL).
 */
export function flagsFor(op: OperationView): CliFlag[] {
  const args = (op.operation["x-mastro-args"] ?? []).map(flagFromWorkflowArg);
  if (op.isWorkflow) return args;
  return [...op.parameters.map(flagFromParameter), ...args];
}

export async function runConnector(
  ctx: CliContext,
  providerId: string,
  rest: string[],
  asJson: boolean,
): Promise<number> {
  const provider = await ensureProvider(ctx, providerId, { asJson });

  if (!provider.spec) {
    ui.error(`"${providerId}" has no OpenAPI spec yet — only \`mastro login ${providerId}\` works.`);
    return 1;
  }

  const [commandName, ...commandArgs] = rest;
  if (!commandName || commandName === "--help" || commandName === "-h") {
    printProviderHelp(provider);
    return commandName ? 0 : 1;
  }

  const op = provider.spec.byCommand(commandName);
  if (!op) {
    ui.error(`Unknown command "${commandName}" for ${providerId}.`);
    printProviderHelp(provider);
    return 1;
  }

  if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
    printOperationHelp(providerId, op);
    return 0;
  }

  // --dry-run applies to every command (print the plan, send nothing); it's
  // not a connector arg, so pull it out first.
  const dryRun = commandArgs.includes("--dry-run");
  const opArgs = commandArgs.filter((a) => a !== "--dry-run");

  const flags = flagsFor(op);
  const parsed = parseArgs(opArgs, flags);

  // The first positional binds to the first declared flag, so
  // `mastro depop search "t-shirt"` works without naming the flag.
  if (parsed.positionals.length > 0 && flags[0] && parsed.flags[flags[0].name] === undefined) {
    parsed.flags[flags[0].name] = parsed.positionals[0]!;
  }

  const args = buildArgsMap(parsed, flags);

  // Auth is only required to actually call the operation — and not at all for
  // a public one (`security: []`).
  const connector = Connector.load(provider, ctx.store, { anonymous: op.isPublic });
  try {
    if (op.isWorkflow) {
      const result = await connector.runWorkflow(op, args, { dryRun });
      await emit(result, asJson);
      return 0;
    }
    if (dryRun) {
      await emit(await connector.plan(op, args), asJson);
      return 0;
    }
    const result = await connector.call(op, args);
    await emit(asJson ? result.data : (result.result ?? result.data), asJson);
    return 0;
  } finally {
    // Release the browser-proxy server (if used) so the process can exit.
    connector.close();
  }
}

// -- help rendering ---------------------------------------------------------

function printProviderHelp(provider: Provider): void {
  ui.heading(`mastro ${provider.id} — ${provider.manifest.display_name}`);
  const cmds = provider.spec?.commands() ?? [];
  if (cmds.length === 0) {
    ui.info("This connector exposes no commands yet.");
    return;
  }
  ui.print("\nCommands:");
  for (const c of cmds) {
    ui.print(`  ${pc.bold((c.command ?? "").padEnd(16))} ${pc.dim(c.summary ?? "")}`);
  }
  ui.print(`\nRun \`mastro ${provider.id} <command> --help\` for flags.`);
}

function printOperationHelp(providerId: string, op: OperationView): void {
  ui.heading(`mastro ${providerId} ${op.command}`);
  if (op.summary) ui.print(op.summary);
  if (op.description) ui.print(pc.dim(op.description));

  const flags = flagsFor(op);
  if (flags.length === 0) {
    ui.print("\nNo flags.");
    return;
  }
  ui.print("\nFlags:");
  for (const f of flags) ui.print("  " + flagHelp(f));
}

function flagHelp(f: CliFlag): string {
  const req = f.required ? pc.red(" (required)") : "";
  const repeat = f.multiple ? pc.dim(" [repeatable]") : "";
  const choiceHint = f.enum?.length ? pc.dim(` {${f.enum.join(", ")}}`) : "";
  const resolveHint = f.resolvable ? pc.dim(" [accepts id or label]") : "";
  return `--${f.name.padEnd(16)} ${pc.dim(f.description ?? "")}${choiceHint}${resolveHint}${req}${repeat}`;
}
