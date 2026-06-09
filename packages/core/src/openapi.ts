/**
 * The OpenAPI 3.1 subset mastro consumes, plus the `x-mastro-*` extensions.
 *
 * A connector's API is described as a *valid* OpenAPI 3.1 document. We model
 * only the parts we actually read (paths → operations → parameters → schemas,
 * security schemes) rather than the entire spec — but a full OpenAPI doc is
 * still accepted, we just ignore what we don't use.
 *
 * Three things OpenAPI genuinely cannot express live in spec-legal `x-`
 * extensions (validators MUST ignore unknown `x-` keys, so the document stays a
 * conformant OpenAPI 3.1 doc):
 *
 *   x-mastro-auth     replay choreography: which captured fields become which
 *                     headers/cookies, and per-request generated values (uuid).
 *   x-mastro-resolve  a parameter whose valid values come from ANOTHER
 *                     operation's response (dynamic taxonomies: sizes, brands).
 *   x-mastro-command  the CLI subcommand name for an operation (defaults to
 *                     operationId).
 *   x-mastro-result   dotted path to the "interesting" part of a response, for
 *                     pretty-printing.
 *   x-mastro-hidden   omit this operation from the CLI (metadata-only endpoints).
 */

// ---------------------------------------------------------------------------
// OpenAPI document (the subset we read)
// ---------------------------------------------------------------------------

export interface OpenApiDocument {
  openapi: string;
  info: OpenApiInfo;
  servers?: OpenApiServer[];
  paths: Record<string, PathItem>;
  components?: {
    securitySchemes?: Record<string, SecurityScheme>;
  };
  /** Replay choreography — how captured credentials become live requests. */
  "x-mastro-auth"?: MastroAuth;
  /** Transport tuning: browser impersonation, retry/recapture codes, rate limit. */
  "x-mastro-replay"?: MastroReplay;
}

export interface OpenApiInfo {
  title: string;
  version: string;
  description?: string;
}

export interface OpenApiServer {
  url: string;
  description?: string;
}

export type HttpMethod = "get" | "put" | "post" | "delete" | "patch";

export type PathItem = {
  [M in HttpMethod]?: Operation;
};

export interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: RequestBody;
  responses?: Record<string, ResponseObject>;
  /** AND-combined security requirements; each entry names schemes that all apply. */
  security?: SecurityRequirement[];
  /** CLI subcommand name. Defaults to operationId. */
  "x-mastro-command"?: string;
  /** Dotted path into the response body for pretty-printing (e.g. "objects"). */
  "x-mastro-result"?: string;
  /** Hide this operation from the CLI (e.g. taxonomy-metadata endpoints). */
  "x-mastro-hidden"?: boolean;
  /**
   * Make this a multi-step *workflow* command instead of a single request.
   * The operation itself isn't called; its steps are, in order. Used for
   * stateful flows like "upload pictures → create listing".
   */
  "x-mastro-workflow"?: MastroWorkflow;
  /**
   * CLI flags for a workflow command (workflows have no `parameters` of their
   * own — their requests pull from `${args.*}` and earlier `${steps.*}`).
   */
  "x-mastro-args"?: WorkflowArg[];
}

// ---------------------------------------------------------------------------
// x-mastro-workflow — declarative multi-step orchestration
// ---------------------------------------------------------------------------

export interface MastroWorkflow {
  steps: WorkflowStep[];
  /** Dotted path into the final step's result to print (e.g. "result"). */
  result?: string;
}

/**
 * A workflow step. Every step calls an operation (`operationId`) and stores its
 * outcome under `id` (referenceable as `${steps.<id>...}`). Modifiers:
 *   - `foreach`: run once per element of a list expression, collecting results.
 *   - `poll`: repeat until `until` is truthy (or attempts exhausted).
 *   - `request`: per-step overrides (templated url/body/headers, transport).
 */
export interface WorkflowStep {
  id: string;
  /**
   * The operation to call. Omit for a *pure transform* step: no HTTP call is
   * made; the step's `value` (templated, defaults to the foreach `${item}`) is
   * shaped through `output` (path/extract/coerce). Used to derive data from a
   * prior step — e.g. numeric picture ids from slot URLs — without a round-trip.
   */
  operationId?: string;
  description?: string;
  /** Run this step once per item of a template list, e.g. "${args.photo}". */
  foreach?: string;
  /** Inside a foreach, the current item is bound to this name in `${item}`. */
  as?: string;
  /** A transform step's input expression (templated). Defaults to `${item}`. */
  value?: string;
  /** Per-step request shaping (templated). */
  request?: WorkflowRequest;
  /** Poll config — repeat the request until `until` resolves truthy. */
  poll?: WorkflowPoll;
  /** Extract/transform the response into this step's stored result. */
  output?: WorkflowOutput;
}

export interface WorkflowRequest {
  /** Override the URL (template). Use for presigned URLs from a prior step. */
  url?: string;
  /** Override the HTTP method. */
  method?: HttpMethod | Uppercase<HttpMethod>;
  /** Body (object template, deep-resolved) or a raw template string. */
  body?: unknown;
  /** Extra headers (templated). */
  headers?: Record<string, string>;
  /** Skip x-mastro-auth for this request (e.g. presigned S3 PUT). */
  no_auth?: boolean;
  /** Force a transport: "direct" (plain fetch) or "browser" (extension proxy). */
  transport?: "direct" | "browser";
}

export interface WorkflowPoll {
  /** Truthy template = done, e.g. "${steps.batch.result.ready}". */
  until: string;
  /** Max attempts before failing. Default 15. */
  attempts?: number;
  /** Delay between attempts in ms. Default 1000. */
  delay_ms?: number;
}

export interface WorkflowOutput {
  /** Dotted/`[]` path into the response body to keep as this step's result. */
  path?: string;
  /**
   * Optional regex applied to a string result; if it has a capture group, the
   * first group is kept. Used to pull a picture id out of an S3 URL.
   */
  extract?: string;
  /**
   * Optional type coercion for the extracted/selected value. `number` parses a
   * numeric string into a JS number — needed when a later step's body must send
   * the value as a JSON number (e.g. Depop's validate wants integer picture ids,
   * not strings).
   */
  coerce?: "number";
}

export interface WorkflowArg {
  name: string;
  description?: string;
  required?: boolean;
  /** Repeatable flag → collected into a list (e.g. --photo). */
  multiple?: boolean;
  /** Closed value set. */
  enum?: string[];
  /** A boolean flag (no value). */
  boolean?: boolean;
  /** Resolve valid values from another operation (same as a parameter's). */
  "x-mastro-resolve"?: MastroResolve;
}

export interface Parameter {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: SchemaObject;
  /** Array serialization (OpenAPI). Defaults: style=form, explode=true for query. */
  style?: "form" | "spaceDelimited" | "pipeDelimited" | "simple";
  explode?: boolean;
  /** Resolve this parameter's valid values from another operation's response. */
  "x-mastro-resolve"?: MastroResolve;
}

export interface RequestBody {
  required?: boolean;
  content: Record<string, MediaType>;
}

export interface MediaType {
  schema?: SchemaObject;
}

export interface ResponseObject {
  description?: string;
  content?: Record<string, MediaType>;
}

/** The JSON-Schema subset we inspect (for flags, enums, array items). */
export interface SchemaObject {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  enum?: (string | number | boolean)[];
  items?: SchemaObject;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
}

// ---------------------------------------------------------------------------
// Security (OpenAPI native — we read it, but binding is via x-mastro-auth)
// ---------------------------------------------------------------------------

export type SecurityRequirement = Record<string, string[]>;

export type SecurityScheme =
  | { type: "http"; scheme: "bearer" | "basic"; bearerFormat?: string }
  | { type: "apiKey"; in: "header" | "cookie" | "query"; name: string };

// ---------------------------------------------------------------------------
// x-mastro-auth — how a captured credential becomes a live request
// ---------------------------------------------------------------------------

export interface MastroAuth {
  /** Capture-bundle fields that must be present to call any secured operation. */
  required_fields?: string[];
  /**
   * Optional post-capture liveness check. After `mastro login` persists a
   * credential, the broker calls this operation once; a 2xx confirms the
   * session actually works (not just that the required fields are present), and
   * the real outcome is stored in the credential's `validation`. Name a cheap,
   * read-only operation (e.g. Depop's `me`). Omit to skip verification.
   */
  verify?: { operationId: string };
  /**
   * Headers added to every request. Templates resolve against the persisted
   * credential and generators, e.g.:
   *   "authorization": "Bearer ${auth.access_token}"
   *   "x-user-id":     "${auth.user_id}"
   *   "x-device-id":   "${uuid}"        (fresh per request)
   *   "x-ts":          "${now}"         (unix seconds)
   */
  headers?: Record<string, string>;
  /** Cookie name → template, joined into a single Cookie header. */
  cookies?: Record<string, string>;
  /** Header/cookie names whose values must be redacted in logs. */
  redact?: string[];
}

// ---------------------------------------------------------------------------
// x-mastro-resolve — dynamic enums sourced from another operation
// ---------------------------------------------------------------------------

export interface MastroResolve {
  /**
   * Where the taxonomy comes from. Either:
   *   - an `operationId` (a live metadata endpoint, fetched + cached), or
   *   - `"file:<path>"` — a JSON file bundled in the provider directory
   *     (e.g. "file:reference/categories.json"). Use for large, stable lookups
   *     that don't need a network round-trip.
   */
  from: string;
  /**
   * Dotted path (supports `[]` array wildcard) to the WIRE value within each
   * taxonomy item, e.g. "[].composite_id". Omit for a keyed object source
   * where the value IS the looked-up entry (see `key`).
   */
  value_path?: string;
  /** Dotted path to the human LABEL within each item, e.g. "[].name". */
  label_path?: string;
  /**
   * For a file source that is a keyed object (`{ "menswear/jumpers": {...} }`),
   * look the input up by key and return the field at `value_path` of the entry.
   * The input is matched against the object's keys directly.
   */
  keyed?: boolean;
  /**
   * Build the lookup key from OTHER args instead of this flag's own value, via a
   * template (e.g. "${args.department}/${args.type}"). Used for derived flags
   * like variant_set (from department+type) or gender (from department).
   */
  key_template?: string;
  /** Cache TTL in seconds for a fetched (operation) taxonomy. Default 86400. */
  cache_ttl?: number;
}

// ---------------------------------------------------------------------------
// Replay rules (origin/impersonation) — small, kept as a root extension too
// ---------------------------------------------------------------------------

export interface MastroReplay {
  /**
   * Run requests through the mastro extension's authenticated browser tab.
   * Required for sites behind a Cloudflare/Akamai *managed challenge* (a JS
   * interstitial), which TLS impersonation alone cannot solve. Takes precedence
   * over `impersonate_browser`. See docs/BROWSER-PROXY.md.
   */
  via_browser?: boolean;
  impersonate_browser?: boolean;
  user_agent?: string;
  retry_on?: number[];
  recapture_on?: number[];
  rate_limit?: { requests_per_minute: number };
}
