/** Consistent terminal output: colored human text, or clean JSON for agents. */
import pc from "picocolors";

/** True when output should be machine-readable JSON (--json or piped). */
export function jsonMode(argv: string[]): boolean {
  return argv.includes("--json");
}

export const ui = {
  info: (msg: string) => console.error(pc.dim(msg)),
  success: (msg: string) => console.error(pc.green("✓ ") + msg),
  warn: (msg: string) => console.error(pc.yellow("! ") + msg),
  error: (msg: string) => console.error(pc.red("✗ ") + msg),
  heading: (msg: string) => console.error(pc.bold(msg)),
};

/** Print a command's result: pretty for humans, raw JSON for machines. */
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
