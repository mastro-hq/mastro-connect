/** Consistent terminal output: colored human text, or clean JSON for agents. */
import pc from "picocolors";

/** True when output should be machine-readable JSON (--json or piped). */
export function jsonMode(argv: string[]): boolean {
  return argv.includes("--json");
}

/**
 * Output channels, split by stream so the CLI behaves like a good Unix tool:
 *
 *   stdout — what the user is meant to READ as a normal outcome: command
 *            results (via `emit`), help, listings, progress notes, and the
 *            success confirmation. Many terminals tint the WHOLE stderr stream
 *            red, so a fully-successful flow whose progress went to stderr
 *            reads as a failure. Anything that isn't a problem stays here.
 *   stderr — only genuine problems: warnings and errors. These are the lines
 *            the user *should* see in red, and the ones that survive when
 *            stdout is piped elsewhere.
 */
const out = (msg: string) => console.log(msg);
const err = (msg: string) => console.error(msg);

export const ui = {
  /** A primary block the user requested (help, a listing). → stdout */
  print: out,
  /** Section title for a primary block. → stdout */
  heading: (msg: string) => out(pc.bold(msg)),
  /** Background hint or progress note — not a problem. → stdout */
  info: (msg: string) => out(pc.dim(msg)),
  /** A completed action — not a problem. → stdout */
  success: (msg: string) => out(pc.green("✓ ") + msg),
  /** A non-fatal caution. → stderr (red tint is warranted). */
  warn: (msg: string) => err(pc.yellow("! ") + msg),
  /** A failure. → stderr (red tint is warranted). */
  error: (msg: string) => err(pc.red("✗ ") + msg),
};

/** Print a command's result: pretty for humans, raw JSON for machines. → stdout */
export function emit(data: unknown, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (typeof data === "string") {
    console.log(data);
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

export { pc };
