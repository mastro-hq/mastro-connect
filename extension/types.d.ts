/**
 * Shared types for the mastro capture extension.
 *
 * These mirror the runtime contracts in `@mastro/core` (AuthManifest,
 * CaptureBundle). They're declared here as ambient types so the plain-JS
 * extension files can be `checkJs`-verified without a bundler or imports.
 */

// -- manifest (subset the extension actually reads) -------------------------

interface MastroCookieRule {
  url: string;
  include_names_matching: string[];
  save_as?: string;
}

interface MastroHeaderRule {
  source: "request" | "response";
  url_matches: string;
  is_regex?: boolean;
  include_names: string[];
  save_as?: string;
}

interface MastroPageEventRule {
  source: "fetch-response" | "xhr-response";
  url_matches: string;
  is_regex?: boolean;
  body_json_path?: string;
  save_as: string;
}

interface MastroStorageRule {
  area: "local" | "session";
  keys?: string[];
  save_as?: string;
}

interface MastroCaptureSpec {
  cookies?: MastroCookieRule[];
  headers?: MastroHeaderRule[];
  page_events?: MastroPageEventRule[];
  storage?: MastroStorageRule[];
}

type MastroCompletionRule =
  | { all: MastroCompletionRule[] }
  | { any: MastroCompletionRule[] }
  | { not: MastroCompletionRule }
  | { field_present: string }
  | { cookie_present: string }
  | { cookie_name_prefix_present: string }
  | { header_seen: string }
  | { storage_key_present: string }
  | { authenticated_response_seen: string };

interface MastroSerializationSpec {
  output_schema: string;
  fields: Record<string, string>;
}

interface MastroAuthManifest {
  schema_version: string;
  provider_id: string;
  display_name: string;
  launch: { url: string; open_tab?: boolean; expected_origins: string[]; timeout_seconds: number };
  permissions: { host_permissions: string[]; injects_page_bridge?: boolean };
  capture: MastroCaptureSpec;
  completion: MastroCompletionRule;
  serialization: MastroSerializationSpec;
  security: { redact_fields: string[]; allowed_postback_origin: string };
}

// -- session + state --------------------------------------------------------

interface MastroSessionPayload {
  sessionId: string;
  providerId: string;
  displayName: string;
  launchUrl: string;
  manifest: MastroAuthManifest;
}

interface MastroCookie {
  value: string;
  domain: string;
}

/** Accumulated observations during a capture session. */
interface MastroState {
  cookies: Record<string, MastroCookie>;
  headers: Record<string, string>;
  storage: { local: Record<string, string>; session: Record<string, string> };
  /** Internal: URLs of successful authenticated responses. */
  __authedResponses?: string[];
  /** Extracted page-event values land here by their `save_as` path. */
  [key: string]: unknown;
}

interface MastroSession {
  sessionId: string;
  providerId: string;
  receiverBaseUrl: string;
  manifest: MastroAuthManifest;
  launchUrl: string;
  appTabId: number | undefined;
  bootstrapTabId: number | undefined;
  state: MastroState;
  seenHeaders: Set<string>;
  submitted: boolean;
}

// -- worker messages (content scripts → background) -------------------------

type MastroMessage =
  | { action: "startAuthSession"; session: MastroSessionPayload; receiverBaseUrl: string }
  | { action: "isSessionTab" }
  | { action: "getStatus" }
  | { action: "pageReady"; url: string }
  | { action: "bridgeEvent"; detail: MastroBridgeEvent };

// -- browser proxy (run requests in an authenticated tab) -------------------

interface ProxyRequest {
  id: string;
  origin: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

// -- page-bridge event payloads ---------------------------------------------

type MastroBridgeEvent =
  | { type: "fetch-response"; url: string; status: number; bodyText: string }
  | { type: "xhr-response"; url: string; status: number; bodyText: string }
  | {
      type: "storage-snapshot";
      local: Record<string, string>;
      session: Record<string, string>;
    };
