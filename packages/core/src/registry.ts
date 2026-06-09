/**
 * Provider registry — discovers and loads `providers/<id>/` artifacts.
 *
 * A provider is a directory containing:
 *   auth.manifest.json            (required)  what to capture in the browser
 *   openapi.yaml | openapi.json   (optional)  the API surface (OpenAPI 3.1 +
 *                                             x-mastro-* extensions)
 *   README.md, skills/            (optional)  docs
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { OpenApiSpec, parseOpenApi } from "./openapi-spec.ts";
import { validateManifest } from "./schemas/index.ts";
import type { AuthManifest } from "./types.ts";

export interface Provider {
  id: string;
  dir: string;
  manifest: AuthManifest;
  /** Present only if the provider ships an OpenAPI spec. */
  spec?: OpenApiSpec;
}

export class ProviderNotFoundError extends Error {
  constructor(public readonly providerId: string, public readonly searched: string[]) {
    super(
      `Unknown provider "${providerId}". Searched:\n  ${searched.join("\n  ")}\n` +
        `Run \`mastro providers\` to list available connectors.`,
    );
    this.name = "ProviderNotFoundError";
  }
}

const SPEC_FILES = ["openapi.yaml", "openapi.yml", "openapi.json"];

export class ProviderRegistry {
  /** @param roots one or more directories that each contain provider folders. */
  constructor(private readonly roots: string[]) {}

  /** List provider ids found across all roots (deduped, first root wins). */
  list(): string[] {
    const seen = new Set<string>();
    for (const root of this.roots) {
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root)) {
        const dir = join(root, name);
        if (statSync(dir).isDirectory() && existsSync(join(dir, "auth.manifest.json"))) {
          seen.add(name);
        }
      }
    }
    return [...seen].sort();
  }

  /** Load a single provider by id. Throws ProviderNotFoundError if missing. */
  load(providerId: string): Provider {
    const searched: string[] = [];
    for (const root of this.roots) {
      const dir = join(root, providerId);
      const manifestPath = join(dir, "auth.manifest.json");
      searched.push(manifestPath);
      if (!existsSync(manifestPath)) continue;

      const manifest = validateManifest(readJson(manifestPath));
      const spec = this.loadSpec(dir);
      return { id: providerId, dir, manifest, spec };
    }
    throw new ProviderNotFoundError(providerId, searched);
  }

  private loadSpec(dir: string): OpenApiSpec | undefined {
    for (const file of SPEC_FILES) {
      const path = join(dir, file);
      if (existsSync(path)) return parseOpenApi(readFileSync(path, "utf8"));
    }
    return undefined;
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
