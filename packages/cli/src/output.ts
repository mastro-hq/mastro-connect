/** Consistent terminal output: colored human text, or clean JSON for agents. */
import pc from "picocolors";

/** True when output should be machine-readable JSON (--json or piped). */
export function jsonMode(argv: string[]): boolean {
  return argv.includes("--json");
}

/**
 * Output channels, split by stream so the CLI behaves like a good Unix tool:
 *
 *   stdout — what the user asked to SEE: command results (via `emit`), help
 *            text, and listings. Pipeable; never tinted as an "error".
 *   stderr — diagnostics ABOUT the run: progress, hints, warnings, errors.
 *
 * Terminals commonly render stderr in red, which is why help printed to the
 * wrong stream looked like an error. Anything a user reads as output goes to
 * stdout; only side-channel chatter goes to stderr.
 */
const out = (msg: string) => console.log(msg);
const err = (msg: string) => console.error(msg);

export const ui = {
  /** A primary block the user requested (help, a listing). → stdout */
  print: out,
  /** Section title for a primary block. → stdout */
  heading: (msg: string) => out(pc.bold(msg)),
  /** Background hint or progress note. → stderr */
  info: (msg: string) => err(pc.dim(msg)),
  /** A completed action. → stderr (it's a status, not the result). */
  success: (msg: string) => err(pc.green("✓ ") + msg),
  /** A non-fatal caution. → stderr */
  warn: (msg: string) => err(pc.yellow("! ") + msg),
  /** A failure. → stderr */
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
