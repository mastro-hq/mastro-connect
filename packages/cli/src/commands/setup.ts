/**
 * `mastro setup` — the guided first run.
 *
 * Shows the connector catalog as a checklist, installs what the user picks,
 * then offers the two other one-time steps only when they're needed: the
 * browser extension (if a picked connector has commands that need a login) and
 * agent skills (into ~/.claude/skills). Interactive by design; scripts and
 * agents use `providers add` / auto-install instead.
 */
import { createInterface, type Interface } from "node:readline/promises";

import type { Provider } from "@mastro/core";

import { UsageError } from "../args.ts";
import type { CliContext } from "../context.ts";
import { pc, ui } from "../output.ts";
import { DEFAULT_REF, DEFAULT_REPO, fetchProvider, listRemoteProviders, type RemoteProvider } from "../provider-fetch.ts";
import { installSkill, installTarget, providerSkills } from "../skill-files.ts";
import { extensionInstalled, extensionOutdated, installExtension } from "./extension.ts";
import { rootSkill } from "./skills.ts";

export async function setup(ctx: CliContext): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UsageError(
      "setup is interactive — in scripts, just call a connector (it installs itself) or run `mastro providers add <id>`.",
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const picked = await pickConnectors(ctx, rl);
    if (picked.length === 0) {
      ui.info("Nothing picked. Run `mastro setup` again any time.");
      return 0;
    }

    const needLogin = picked.filter(hasLoginCommands);
    if (needLogin.length > 0 && (!extensionInstalled() || extensionOutdated())) {
      const names = needLogin.map((p) => p.manifest.display_name).join(", ");
      ui.print(
        extensionInstalled()
          ? "\nYour mastro browser extension is out of date."
          : `\nSome ${names} commands need a login, which uses the mastro browser extension.`,
      );
      if (await confirm(rl, "Set up the extension now?")) await installExtension(false, true);
    }

    const skills = [rootSkill(), ...picked.flatMap((p) => providerSkills(p.id, p.dir))];
    ui.print(`\nAgent skills for these: ${skills.map((s) => s.name).join(", ")}`);
    if (await confirm(rl, "Install them for Claude Code (~/.claude/skills)?")) {
      const target = installTarget({ global: true });
      for (const skill of skills) ui.success(`${skill.name} → ${installSkill(skill, target)}`);
    }

    printNextSteps(picked, needLogin);
    return 0;
  } catch (err) {
    if (!(err instanceof SetupCancelled)) throw err;
    ui.print("\nSetup cancelled.");
    return 1;
  } finally {
    rl.close();
  }
}

async function pickConnectors(ctx: CliContext, rl: Interface): Promise<Provider[]> {
  ui.heading("mastro setup");
  ui.info(`Fetching the connector catalog (${DEFAULT_REPO})…`);
  const catalog = await listRemoteProviders(DEFAULT_REPO, DEFAULT_REF);
  const installed = new Set(ctx.registry.list());

  ui.print("");
  catalog.forEach((c, i) => {
    const mark = installed.has(c.id) ? pc.green(" ✓ installed") : "";
    ui.print(`  ${pc.bold(String(i + 1).padStart(2))}. ${c.id.padEnd(18)} ${pc.dim(c.display_name)}${mark}`);
  });
  ui.print("");

  let chosen: RemoteProvider[] | undefined;
  while (chosen === undefined) {
    const answer = (await ask(rl, "Install which? Numbers separated by spaces, or Enter for all: ")).trim();
    try {
      chosen = answer === "" || answer.toLowerCase() === "all" ? catalog : parseChoice(answer, catalog);
    } catch (err) {
      ui.warn(err instanceof Error ? err.message : String(err)); // ask again
    }
  }

  const providers: Provider[] = [];
  for (const c of chosen) {
    const entry = await fetchProvider(c.id, DEFAULT_REPO, DEFAULT_REF);
    ui.success(`${c.id} @ ${entry.commit.slice(0, 7)}`);
    providers.push(ctx.registry.load(c.id));
  }
  return providers;
}

function parseChoice<T>(answer: string, items: readonly T[]): T[] {
  const picked = new Set<T>();
  for (const token of answer.split(/[\s,]+/)) {
    const n = Number(token);
    const item = Number.isInteger(n) ? items[n - 1] : undefined;
    if (item === undefined) throw new UsageError(`"${token}" isn't one of the numbers listed`);
    picked.add(item);
  }
  return [...picked];
}

/** Whether any command needs a stored session (i.e. isn't `security: []`). */
function hasLoginCommands(provider: Provider): boolean {
  return provider.spec?.commands().some((op) => !op.isPublic) ?? true;
}

class SetupCancelled extends Error {}

/**
 * One question that also ends when the input does (Ctrl-D / Ctrl-C closes the
 * interface). A bare `rl.question` can stay pending forever after close.
 */
function ask(rl: Interface, question: string): Promise<string> {
  const abort = new AbortController();
  const onClose = () => abort.abort();
  rl.once("close", onClose);
  return rl
    .question(question, { signal: abort.signal })
    .catch((err: unknown) => {
      throw abort.signal.aborted ? new SetupCancelled() : err;
    })
    .finally(() => rl.off("close", onClose));
}

async function confirm(rl: Interface, question: string): Promise<boolean> {
  const answer = (await ask(rl, `${question} [Y/n] `)).trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

function printNextSteps(picked: Provider[], needLogin: Provider[]): void {
  const lines = [`mastro ${picked[0]!.id} --help`];
  for (const p of needLogin) lines.push(`mastro login ${p.id}`);
  ui.print(`\nYou're set. Try:\n${lines.map((l) => `  ${l}`).join("\n")}`);
}
