/**
 * Credential store — where validated captures live on disk.
 *
 * `CredentialStore` is the interface; `FileStore` is the default backend
 * (one JSON file per provider under ~/.mastro/credentials, mode 0600).
 * Keychain / secret-manager backends can implement the same interface later.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PersistedCredential } from "./types.ts";

export interface CredentialStore {
  get(providerId: string): PersistedCredential | undefined;
  set(providerId: string, credential: PersistedCredential): void;
  delete(providerId: string): boolean;
  list(): string[];
}

/** Default root: ~/.mastro (override with MASTRO_HOME). */
export function mastroHome(): string {
  return process.env.MASTRO_HOME ?? join(homedir(), ".mastro");
}

export class FileStore implements CredentialStore {
  private readonly dir: string;

  constructor(root: string = mastroHome()) {
    this.dir = join(root, "credentials");
  }

  get(providerId: string): PersistedCredential | undefined {
    const path = this.pathFor(providerId);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as PersistedCredential;
  }

  set(providerId: string, credential: PersistedCredential): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = this.pathFor(providerId);
    // Write then tighten perms — the secret never touches a world-readable file.
    writeFileSync(path, JSON.stringify(credential, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  delete(providerId: string): boolean {
    const path = this.pathFor(providerId);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  }

  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
  }

  private pathFor(providerId: string): string {
    return join(this.dir, `${providerId}.json`);
  }
}

/** True if the credential has an expiry in the past. */
export function isExpired(credential: PersistedCredential, nowSeconds = unixNow()): boolean {
  return credential.expires_at !== undefined && credential.expires_at <= nowSeconds;
}

export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}
