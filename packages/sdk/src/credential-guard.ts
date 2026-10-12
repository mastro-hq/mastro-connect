/**
 * Credentials only travel to the origins the user logged in to.
 *
 * A connector is data fetched from a repo, and it can change after the user
 * logs in. Whatever its spec says — operation `servers`, a workflow step's
 * `request.url`, a handoff, `${auth.*}` templated into a query or body — two
 * rules hold:
 *
 *   1. Anything run through the user's browser tab must target an origin this
 *      provider's login recorded. The tab sends its own cookies, so such a
 *      request is credentialed whether or not it carries a token. A provider
 *      the user never logged in to has no recorded origins: no browser use.
 *   2. A direct request may go anywhere (public APIs, presigned uploads) unless
 *      it carries a value from the stored credential — in any encoding a
 *      request builder could give it — in which case its origin must be one
 *      recorded at login.
 */
import type { HttpRequest, Transport } from "./transport.ts";

export class CredentialScopeError extends Error {
  constructor(providerId: string, origin: string) {
    super(
      `refusing to send your ${providerId} session to ${origin}: you logged in for other sites. ` +
        `If the connector legitimately moved, run \`mastro login ${providerId}\` again.`,
    );
    this.name = "CredentialScopeError";
  }
}

/** Values shorter than this (ids like "42") are too likely to collide with public data to police. */
const MIN_SECRET_LENGTH = 8;

export class CredentialScope {
  /** Every form a credential value can take on the wire. */
  private readonly needles: string[];
  private readonly origins: Set<string>;

  constructor(
    private readonly providerId: string,
    fields: Record<string, unknown>,
    origins: readonly string[],
  ) {
    const needles = new Set<string>();
    for (const secret of stringLeaves(fields)) {
      for (const form of wireForms(secret)) if (form.length >= MIN_SECRET_LENGTH) needles.add(form);
    }
    this.needles = [...needles];
    this.origins = new Set(origins);
  }

  /** Rule 1: the origin must be one this provider's login recorded. */
  requireOrigin(url: string): void {
    const origin = new URL(url).origin;
    if (!this.origins.has(origin)) throw new CredentialScopeError(this.providerId, origin);
  }

  /** Rule 2: throw if any of `parts` carries a credential value and `url` isn't an allowed origin. */
  check(url: string, parts: readonly string[]): void {
    if (this.needles.length === 0) return;
    const origin = new URL(url).origin;
    if (this.origins.has(origin)) return;
    const haystack = [url, ...parts].flatMap((part) => [part, decodeLoosely(part)]);
    if (haystack.some((text) => this.needles.some((needle) => text.includes(needle)))) {
      throw new CredentialScopeError(this.providerId, origin);
    }
  }

  /**
   * Wrap a transport so every request is checked before it leaves. With
   * `browserTabOrigin` the transport runs in the user's tab on that origin.
   */
  guard(transport: Transport, browser?: { tabOrigin: string | undefined }): Transport {
    return {
      name: transport.name,
      send: async (req: HttpRequest) => {
        if (browser) {
          this.requireOrigin(req.url);
          if (browser.tabOrigin) this.requireOrigin(browser.tabOrigin);
        } else {
          this.check(req.url, [...Object.values(req.headers), bodyText(req.body)]);
        }
        return transport.send(req);
      },
    };
  }
}

/** Every string anywhere in a credential (fields can nest). */
function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringLeaves);
  return [];
}

/** A value as it may appear in a request: raw, unquoted, percent-encoded, form-encoded. */
function wireForms(secret: string): string[] {
  const unquoted = secret.replace(/^"(.*)"$/, "$1");
  return [secret, unquoted].flatMap((s) => [s, encodeURIComponent(s), new URLSearchParams({ v: s }).toString().slice(2)]);
}

/** Percent- and form-decoding, never throwing on a malformed escape. */
function decodeLoosely(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

function bodyText(body: HttpRequest["body"]): string {
  if (body === undefined) return "";
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}
