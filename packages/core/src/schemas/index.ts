/** Runtime validation of provider artifacts against their JSON Schemas. */
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import manifestSchema from "./browser-auth-manifest.schema.json" with { type: "json" };
import type { AuthManifest } from "../types.ts";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const validateManifestFn = ajv.compile(manifestSchema);

export class SchemaError extends Error {
  constructor(
    public readonly artifact: string,
    public readonly errors: string[],
  ) {
    super(`${artifact} failed schema validation:\n  - ${errors.join("\n  - ")}`);
    this.name = "SchemaError";
  }
}

function run<T>(fn: ValidateFunction, value: unknown, artifact: string): T {
  if (!fn(value)) {
    const errors = (fn.errors ?? []).map(
      (e) => `${e.instancePath || "(root)"} ${e.message ?? ""}`.trim(),
    );
    throw new SchemaError(artifact, errors);
  }
  return value as T;
}

/** Validate and narrow an auth manifest. Throws SchemaError on failure. */
export function validateManifest(value: unknown): AuthManifest {
  return run<AuthManifest>(validateManifestFn, value, "auth.manifest.json");
}

export { manifestSchema };
