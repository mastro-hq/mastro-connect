/**
 * A loaded OpenAPI connector spec, with a normalized view over its operations.
 *
 * This is the layer the SDK and CLI consume — it flattens paths × methods into
 * `OperationView`s (with a resolved command name, base URL, parameters, and the
 * x-mastro extensions already pulled out), so callers never walk the raw doc.
 */
import {
  type HttpMethod,
  type MastroAuth,
  type MastroReplay,
  type OpenApiDocument,
  type Operation,
  type Parameter,
} from "./openapi.ts";

const METHODS: HttpMethod[] = ["get", "put", "post", "delete", "patch"];

export class OpenApiSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenApiSpecError";
  }
}

/** One operation, flattened and ready to drive a request or a CLI command. */
export interface OperationView {
  /** Stable id (operationId, or `${method} ${path}` if absent). */
  id: string;
  /** CLI subcommand name (x-mastro-command ?? operationId). Undefined → hidden. */
  command: string | undefined;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  parameters: Parameter[];
  operation: Operation;
  hidden: boolean;
  /** True when this command is a multi-step workflow, not a single request. */
  isWorkflow: boolean;
}

export class OpenApiSpec {
  private readonly operations: OperationView[];
  private readonly byId = new Map<string, OperationView>();

  constructor(readonly doc: OpenApiDocument) {
    if (!doc.openapi?.startsWith("3.")) {
      throw new OpenApiSpecError(`unsupported openapi version: ${doc.openapi}`);
    }
    if (!doc.paths || typeof doc.paths !== "object") {
      throw new OpenApiSpecError("openapi document has no paths");
    }
    this.operations = this.flatten();
    for (const op of this.operations) this.byId.set(op.id, op);
  }

  /** Base server URL (first server, or throws if none). */
  baseUrl(): string {
    const url = this.doc.servers?.[0]?.url;
    if (!url) throw new OpenApiSpecError("openapi document has no servers[].url");
    return url;
  }

  auth(): MastroAuth {
    return this.doc["x-mastro-auth"] ?? {};
  }

  replay(): MastroReplay {
    return this.doc["x-mastro-replay"] ?? {};
  }

  /** All operations, hidden or not. */
  all(): OperationView[] {
    return this.operations;
  }

  /** Operations exposed as CLI commands (have a command and aren't hidden). */
  commands(): OperationView[] {
    return this.operations.filter((o) => o.command !== undefined && !o.hidden);
  }

  byCommand(command: string): OperationView | undefined {
    return this.commands().find((o) => o.command === command);
  }

  byOperationId(id: string): OperationView | undefined {
    return this.byId.get(id);
  }

  private flatten(): OperationView[] {
    const out: OperationView[] = [];
    for (const [path, item] of Object.entries(this.doc.paths)) {
      if (!item) continue;
      for (const method of METHODS) {
        const operation = item[method];
        if (!operation) continue;

        const id = operation.operationId ?? `${method} ${path}`;
        const hidden = operation["x-mastro-hidden"] === true;
        const command = hidden
          ? undefined
          : (operation["x-mastro-command"] ?? operation.operationId);

        out.push({
          id,
          command,
          method,
          path,
          summary: operation.summary,
          description: operation.description,
          parameters: operation.parameters ?? [],
          operation,
          hidden,
          isWorkflow: operation["x-mastro-workflow"] !== undefined,
        });
      }
    }
    return out;
  }
}

/** Parse an OpenAPI document from YAML or JSON text. */
export function parseOpenApi(text: string): OpenApiSpec {
  const trimmed = text.trimStart();
  const doc = (trimmed.startsWith("{") ? JSON.parse(text) : Bun.YAML.parse(text)) as OpenApiDocument;
  return new OpenApiSpec(doc);
}
