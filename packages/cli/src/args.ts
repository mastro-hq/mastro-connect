/**
 * Tiny argv parser. Splits a token list into positionals and flags.
 *
 *   --flag value     → { flag: "value" }
 *   --flag=value     → { flag: "value" }
 *   --bool           → { bool: true }   (when next token is another flag / absent)
 *   --multi a --multi b → { multi: ["a", "b"] }  (when the flag is repeatable)
 *   --no-flag        → { flag: false }
 *
 * Works off a normalized `CliFlag[]` derived from either an operation's OpenAPI
 * parameters or a workflow's x-mastro-args.
 */
import type { Parameter, WorkflowArg } from "@mastro/core";

/** Normalized CLI flag — the common shape parameters and workflow args map to. */
export interface CliFlag {
  name: string;
  description?: string;
  required: boolean;
  multiple: boolean;
  boolean: boolean;
  enum?: string[];
  /** True if values are resolved from a taxonomy (so we skip enum validation). */
  resolvable: boolean;
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

/** OpenAPI parameter → CliFlag. */
export function flagFromParameter(p: Parameter): CliFlag {
  return {
    name: p.name,
    description: p.description,
    required: p.required ?? false,
    multiple: p.schema?.type === "array",
    boolean: p.schema?.type === "boolean",
    enum: (p.schema?.enum ?? p.schema?.items?.enum)?.map(String),
    resolvable: p["x-mastro-resolve"] !== undefined,
  };
}

/** Workflow arg → CliFlag. */
export function flagFromWorkflowArg(a: WorkflowArg): CliFlag {
  return {
    name: a.name,
    description: a.description,
    required: a.required ?? false,
    multiple: a.multiple ?? false,
    boolean: a.boolean ?? false,
    enum: a.enum,
    resolvable: a["x-mastro-resolve"] !== undefined,
  };
}

export function parseArgs(tokens: string[], flags: CliFlag[] = []): ParsedArgs {
  const repeatable = new Set(flags.filter((f) => f.multiple).map((f) => f.name));
  const booleans = new Set(flags.filter((f) => f.boolean).map((f) => f.name));

  const positionals: string[] = [];
  const out: Record<string, string | boolean | string[]> = {};

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok.startsWith("--")) {
      positionals.push(tok);
      continue;
    }

    let name = tok.slice(2);
    let value: string | boolean;

    const eq = name.indexOf("=");
    if (eq !== -1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    } else if (name.startsWith("no-")) {
      name = name.slice(3);
      value = false;
    } else if (booleans.has(name)) {
      value = true;
    } else {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      } else {
        value = true;
      }
    }

    if (repeatable.has(name)) {
      const existing = out[name];
      out[name] = Array.isArray(existing) ? [...existing, String(value)] : [String(value)];
    } else {
      out[name] = value;
    }
  }

  return { positionals, flags: out };
}

/**
 * Validate args against the flag specs and coerce into the `{ name → value }`
 * map the connector/workflow consumes. Enforces `required` and `enum`.
 */
export function buildArgsMap(parsed: ParsedArgs, flags: CliFlag[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const flag of flags) {
    const value = parsed.flags[flag.name];
    if (value === undefined) {
      if (flag.required) missing.push(flag.name);
      continue;
    }
    validateEnum(flag, value);
    out[flag.name] = flag.multiple && !Array.isArray(value) ? [value] : value;
  }

  if (missing.length > 0) {
    throw new UsageError(`missing required flag(s): ${missing.map((m) => `--${m}`).join(", ")}`);
  }
  return out;
}

function validateEnum(flag: CliFlag, value: string | boolean | string[]): void {
  if (!flag.enum || flag.enum.length === 0 || flag.resolvable) return;
  const allowed = new Set(flag.enum);
  const provided = Array.isArray(value) ? value : [String(value)];
  for (const v of provided) {
    if (!allowed.has(v)) {
      throw new UsageError(`--${flag.name} "${v}" is not allowed. Choices: ${[...allowed].join(", ")}`);
    }
  }
}

export class UsageError extends Error {
  /** A usage mistake exits 2 (distinct from a runtime failure's 1). */
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
