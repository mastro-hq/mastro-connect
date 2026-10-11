/** Consistent terminal output: colored human text, or clean JSON for agents. */
import { writeSync } from "node:fs";

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

/**
 * Print a command's result: pretty for humans, raw JSON for machines. → stdout
 *
 * Written straight to fd 1 rather than via console.log: stdout can be in
 * non-blocking mode (terminal detection flips it), and console.log then
 * silently drops whatever doesn't fit the 64 KB pipe buffer — `mastro … --json
 * | jq` got truncated JSON (Bun.write stalls in the same state).
 */
export async function emit(data: unknown, asJson: boolean): Promise<void> {
  const text = !asJson && typeof data === "string" ? data : JSON.stringify(data, null, 2);
  await writeAll(1, Buffer.from(text + "\n"));
}

/** Write every byte to `fd`, waiting out EAGAIN while a non-blocking pipe is full. */
async function writeAll(fd: number, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset);
    } catch (err) {
      if (isErrno(err, "EPIPE")) return; // reader went away (`| head`) — nothing left to do
      if (!isErrno(err, "EAGAIN")) throw err;
      await Bun.sleep(2); // the reader hasn't drained the pipe yet
    }
  }
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code;
}

export { pc };
