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
 *   x-mastro-extract  turn a non-JSON response into structured objects for
 *                     sites with no JSON API — CSS selectors over HTML, or a
 *                     tree walk over a React Server Components (Flight) stream.
 *   x-mastro-body     a raw request-body template for fixed envelopes that
 *                     can't be assembled from `parameters` (server-driven UI).
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
  /**
   * Extract structured objects from an HTML response. For sites whose data
   * only exists server-rendered (no JSON endpoint): the response body is
   * parsed and each `items` match becomes one object, its fields read from
   * selectors/attributes within it. The extracted array replaces the body as
   * the operation's data (x-mastro-result then applies as usual).
   */
  "x-mastro-extract"?: MastroExtract;
  /**
   * A raw request body template, deep-resolved against the call context
   * (`${args.*}` from CLI flags, `${auth.*}` from the credential, `${uuid}`).
   * Use this when the body is a large *fixed* envelope that can't be assembled
   * from `parameters` alone — e.g. LinkedIn's server-driven-UI search POSTs a
   * big static payload with only `keywords` varying. When set, it replaces the
   * parameter-derived body; declared `parameters` still feed the URL/query and
   * the template. A string body is sent verbatim (after templating); an object
   * is JSON-serialized.
   */
  "x-mastro-body"?: unknown;
  /**
   * Extra request headers for *this* operation, templated against the call
   * context (`${args.*}`, `${auth.*}`, `${uuid}`) and merged after the global
   * `x-mastro-auth.headers` so they can override them. Use when one operation
   * needs a different header set than the rest — e.g. LinkedIn's SDUI search
   * speaks a different `accept` and an `x-li-rsc-stream` flag than the Voyager
   * JSON endpoints.
   */
  "x-mastro-headers"?: Record<string, string>;
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
  /**
   * Build the body by replaying an HTML <form> from a prior step's response —
   * for state changes gated behind a server-rendered form with a one-time CSRF
   * token and many hidden fields (e.g. Amazon's Buy Now → place-order). The
   * form is serialized exactly as a browser would submit it; `set`/`unset`
   * override the few fields submission adds. Mutually exclusive with `body`.
   */
  form?: WorkflowFormReplay;
  /** Extra headers (templated). */
  headers?: Record<string, string>;
  /** Skip x-mastro-auth for this request (e.g. presigned S3 PUT). */
  no_auth?: boolean;
  /** Force a transport: "direct" (plain fetch) or "browser" (extension proxy). */
  transport?: "direct" | "browser";
}

export interface WorkflowFormReplay {
  /** Template resolving to the HTML containing the form (e.g. "${steps.buynow}"). */
  html: string;
  /** CSS selector for the form. Defaults to the first <form>. */
  selector?: string;
  /**
   * Field name → templated value. Overrides an existing field in place, or
   * appends a new one (e.g. the clicked submit button, a JS-set flag).
   */
  set?: Record<string, string>;
  /** Field names to drop from the submission. */
  unset?: string[];
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
// x-mastro-extract — structured objects out of a non-JSON response
// ---------------------------------------------------------------------------

/**
 * Turn a response that isn't a consumable JSON API into structured objects.
 * Two response shapes are supported, picked by the `format` discriminant:
 *   - `"html"` (default) — server-rendered HTML, fields read via CSS selectors
 *     (Amazon/Depop search + detail pages). See {@link MastroExtractHtml}.
 *   - `"flight"` — a React Server Components (Flight) stream, where the UI is a
 *     server-driven component tree rather than markup (LinkedIn's search SRP
 *     POSTs to /flagship-web/... and answers with a Flight tree, not JSON). See
 *     {@link MastroExtractFlight}.
 * Both produce the same thing: an array of flat objects that replaces the body
 * as the operation's data (x-mastro-result then applies as usual).
 */
export type MastroExtract = MastroExtractHtml | MastroExtractFlight;

export interface MastroExtractHtml {
  /** HTML extraction is the default — `format` may be omitted. */
  format?: "html";
  /**
   * CSS selector matching one element per result item — array mode (search
   * results). Omit for **single-object mode** (a product detail page): the
   * whole document is one item, field selectors are document-scoped, and the
   * operation's data is one flat object instead of an array.
   */
  items?: string;
  /** Output field name → where to read it from, within (or on) each item. */
  fields: Record<string, ExtractField>;
}

export interface ExtractField {
  /**
   * CSS selector *within* the item element (the runner scopes it by prefixing
   * the `items` selector). Omit to read from the item element itself — only
   * meaningful with `attr`. First match wins.
   */
  selector?: string;
  /** Attribute name to read. Omit to take the element's text content. */
  attr?: string;
}

/**
 * Extract result cards from a React Server Components (Flight) stream.
 *
 * The body is the Flight wire format: newline-delimited `<id>:<payload>` rows,
 * where the page is one big row holding a nested tree of `["$", tag, key,
 * props]` element tuples. There is no markup to run CSS against, so extraction
 * walks the tree instead: it finds each *card* (an element tagged with a known
 * view name), then reads ordered visible text and the card's navigation URL.
 */
export interface MastroExtractFlight {
  format: "flight";
  /**
   * Identifies a result card: an element whose `viewTrackingSpecs.viewName`
   * equals this string (LinkedIn tags each people result
   * `"people-search-result"`). Each match becomes one output object.
   */
  item: string;
  /** Output field name → where to read it from, within each card. */
  fields: Record<string, FlightField>;
}

/**
 * Where one Flight field comes from within a card. The `from` discriminant
 * selects the source:
 *   - `"nav-url"` — the card's first navigation URL (a `NavigateToUrl` action).
 *     With `pattern`, the first capture group of the regex is kept (e.g. the
 *     `/in/<publicId>` slug); without it, the whole URL.
 *   - `"text"` — the card's visible text, read as an ordered sequence with
 *     consecutive duplicates collapsed (an avatar's alt text repeats the name).
 *     Pick one entry by `role` (semantic position) or `match` (first entry
 *     matching the regex).
 */
export type FlightField = FlightNavUrlField | FlightTextField;

export interface FlightNavUrlField {
  from: "nav-url";
  /** Keep capture group 1 of this regex applied to the URL (e.g. the slug). */
  pattern?: string;
}

export interface FlightTextField {
  from: "text";
  /**
   * Semantic position in the card's text sequence (after collapsing repeats
   * and dropping the connection-distance token like "• 3rd+"):
   *   - `"name"`     → the first line (the member's name),
   *   - `"headline"` → the first line after the name that isn't the name again,
   *   - `"location"` → the line after the headline.
   */
  role?: "name" | "headline" | "location";
  /** First text entry matching this regex (e.g. "^•" for the distance badge). */
  match?: string;
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
  /**
   * Follow an HTML meta-refresh interstitial (e.g. Akamai's bm-verify bot
   * check: a flagged request gets a tiny page that meta-refreshes to the same
   * URL plus a one-time token; the follow-up returns the real response). The
   * follow-up is a GET with the same headers, at most 2 hops.
   */
  follow_html_refresh?: boolean;
}
