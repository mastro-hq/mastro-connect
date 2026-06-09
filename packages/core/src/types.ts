/**
 * The data contracts of mastro-connect.
 *
 * These cover the browser-capture half of a connector:
 *   1. AuthManifest         — what the extension should capture and when it's done.
 *   2. CaptureBundle        — what the extension posts back.
 *   3. PersistedCredential  — the minimal record the broker stores.
 *
 * The API-replay half is described by the provider's OpenAPI 3.1 document (with
 * `x-mastro-*` extensions); see `openapi.ts`. Everything here is declarative so
 * a provider is "data, not code".
 */

// ---------------------------------------------------------------------------
// 1. Auth manifest  (providers/<id>/auth.manifest.json)
// ---------------------------------------------------------------------------

export interface AuthManifest {
  /** Versioned spec id, e.g. "browser-auth-manifest/v1". */
  schema_version: string;
  /** Stable provider key, e.g. "depop". */
  provider_id: string;
  /** Human-readable name shown in setup UI. */
  display_name: string;
  launch: LaunchSpec;
  permissions: PermissionSpec;
  capture: CaptureSpec;
  completion: CompletionRule;
  serialization: SerializationSpec;
  security: SecuritySpec;
}

export interface LaunchSpec {
  /** Page to open. HTTPS required unless host is localhost/127.0.0.1. */
  url: string;
  /** Open the launch URL in a new tab. Default true. */
  open_tab?: boolean;
  /** Only tabs on these origins can satisfy the session. */
  expected_origins: string[];
  /** Hard cap on how long the user has to complete login, in seconds. */
  timeout_seconds: number;
}

export interface PermissionSpec {
  /** Host match patterns the extension needs, e.g. ["https://www.depop.com/*"]. */
  host_permissions: string[];
  observes_cookies?: boolean;
  observes_request_headers?: boolean;
  observes_request_body?: boolean;
  observes_response_headers?: boolean;
  /** Inject page-bridge.js to see page-level fetch/XHR and storage. */
  injects_page_bridge?: boolean;
  observes_storage?: boolean;
}

/** What to watch and what to pull out of it. */
export interface CaptureSpec {
  cookies?: CookieRule[];
  headers?: HeaderRule[];
  page_events?: PageEventRule[];
  storage?: StorageRule[];
}

export interface CookieRule {
  /** URL whose cookie jar to read. "$launch.url" resolves to the launch URL. */
  url: string;
  /** Capture cookies whose names match any of these regexes. */
  include_names_matching: string[];
  /** State field to store the result under. Defaults to "cookies". */
  save_as?: string;
}

export interface HeaderRule {
  source: "request" | "response";
  /** Substring (or regex with `is_regex`) the request URL must match. */
  url_matches: string;
  is_regex?: boolean;
  /** Header names to capture (lower-cased). */
  include_names: string[];
  save_as?: string;
}

export interface PageEventRule {
  source: "fetch-response" | "xhr-response";
  url_matches: string;
  is_regex?: boolean;
  /** JSONPath-ish dotted path into the response body, e.g. "entry.0.content.token". */
  body_json_path?: string;
  /** State field to store the extracted value under. */
  save_as: string;
}

export interface StorageRule {
  area: "local" | "session";
  /** Keys to snapshot. Omit to snapshot all (size-capped). */
  keys?: string[];
  save_as?: string;
}

// ---- completion -----------------------------------------------------------

/** A boolean predicate tree deciding when capture is complete. */
export type CompletionRule =
  | { all: CompletionRule[] }
  | { any: CompletionRule[] }
  | { not: CompletionRule }
  | CompletionPredicate;

export type CompletionPredicate =
  | { field_present: string }
  | { cookie_present: string }
  | { cookie_name_prefix_present: string }
  | { header_seen: string }
  | { storage_key_present: string }
  | { authenticated_response_seen: string };

// ---- serialization --------------------------------------------------------

export interface SerializationSpec {
  /** Schema id the produced bundle conforms to. */
  output_schema: string;
  /**
   * Map of output field -> template string. Templates resolve against captured
   * state with `${...}` interpolation, e.g. "${state.token}",
   * "${cookies.access_token.value}".
   */
  fields: Record<string, string>;
}

export interface SecuritySpec {
  /** Field names to redact from any log or summary. */
  redact_fields: string[];
  /** Persist only the serialized fields, never raw observations. Default true. */
  persist_minimum?: boolean;
  /** Origin the extension is allowed to post captures to. */
  allowed_postback_origin: string;
}

// ---------------------------------------------------------------------------
// 2. Capture bundle  (posted by the extension)
// ---------------------------------------------------------------------------

export interface CaptureBundle {
  schema_version: string;
  provider_id: string;
  /** Unix seconds. */
  captured_at: number;
  /** Unix seconds. Optional; provider may not know token lifetime. */
  expires_at?: number;
  /** The serialized credential fields the OpenAPI x-mastro-auth will consume. */
  credentials: Record<string, unknown>;
  browser_context?: {
    user_agent?: string;
    locale?: string;
  };
  metadata?: {
    method: "extension";
    observations_used: string[];
  };
}

// ---------------------------------------------------------------------------
// Persisted credential  (what the store holds)
// ---------------------------------------------------------------------------

export interface PersistedCredential {
  provider_id: string;
  captured_at: number;
  expires_at?: number;
  /** The credential fields, ready to feed into OpenAPI x-mastro-auth templates. */
  fields: Record<string, unknown>;
  browser_context?: CaptureBundle["browser_context"];
  validation?: ValidationResult;
}

export interface ValidationResult {
  ok: boolean;
  checked_at: number;
  detail?: string;
}
