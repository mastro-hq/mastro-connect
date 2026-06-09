/** Open a URL in the user's browser, cross-platform, without extra deps. */
import { spawn } from "node:child_process";

export function openInBrowser(url: string): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === "darwin"
      ? (["open", [url]] as const)
      : platform === "win32"
        ? (["cmd", ["/c", "start", "", url]] as const)
        : (["xdg-open", [url]] as const);

  const child = spawn(cmd, [...args], { stdio: "ignore", detached: true });
  child.on("error", () => {
    // Non-fatal: the user can open the URL by hand. The broker logs it.
  });
  child.unref();
}
